/**
 * Persistent Kanban store backed by `$PIG_DIR/kanban.json` (mode 0600) and `$PIG_DIR/kanban-images/`.
 * Enforces strict read validation (never overwrites corrupted JSON with empty defaults),
 * serializes mutations through a single queue with atomic writes, and maps Git worktree cwds
 * back to their canonical opened project root.
 */
import * as electron from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  formatKanbanIssueClipboardText,
  isKanbanPriority,
  isKanbanStatus,
  isSafeKanbanImageId,
  kanbanImageExtension,
  parseKanbanImageUrl,
  type KanbanCreateInput,
  type KanbanImageAttachment,
  type KanbanImageInput,
  type KanbanIssue,
  type KanbanLinkedSession,
  type KanbanListFilter,
  type KanbanPriority,
  type KanbanSnapshot,
  type KanbanStatus,
  type KanbanUpdateInput
} from '../../shared/kanban'
import { base64Body, imageMimeType } from '../../shared/session-images'
import { isChatCwd } from '../chats'
import { listOpenedCwds } from '../opened-projects'
import { pigPath } from '../pig-dir'
import { worktrees } from '../project-worktrees'

const MAX_TITLE_LENGTH = 500
const MAX_DESCRIPTION_LENGTH = 100_000
const MAX_LABELS = 24
const MAX_LABEL_LENGTH = 64
const MAX_IMAGES_PER_ISSUE = 12
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

interface PersistedKanbanFile {
  version: 1
  revision: number
  nextNumber: number
  items: KanbanIssue[]
}

const PRIORITY_RANK: Record<KanbanPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4
}

const STATUS_RANK: Record<KanbanStatus, number> = {
  in_progress: 0,
  in_review: 1,
  todo: 2,
  backlog: 3,
  done: 4,
  canceled: 5
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Issue title must be a string')
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Issue title cannot be empty')
  if (trimmed.length > MAX_TITLE_LENGTH) throw new Error(`Issue title exceeds ${MAX_TITLE_LENGTH} characters`)
  return trimmed
}

function normalizeDescription(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error('Issue description must be a string')
  if (value.length > MAX_DESCRIPTION_LENGTH) throw new Error(`Issue description exceeds ${MAX_DESCRIPTION_LENGTH} characters`)
  return value.replace(/\r\n?/g, '\n')
}

function normalizeLabels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Issue labels must be an array')
  const unique: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('Each label must be a string')
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.length > MAX_LABEL_LENGTH) throw new Error(`Label exceeds ${MAX_LABEL_LENGTH} characters`)
    const key = trimmed.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(trimmed)
    }
  }
  if (unique.length > MAX_LABELS) throw new Error(`At most ${MAX_LABELS} labels are allowed`)
  return unique
}

function normalizeProjectCwd(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error('Issue projectCwd must be a string or null')
  return resolve(value)
}

function parseImagesMeta(raw: unknown): KanbanImageAttachment[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('Invalid kanban issue images')
  const seen = new Set<string>()
  const out: KanbanImageAttachment[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid kanban image record')
    }
    const img = entry as Partial<KanbanImageAttachment>
    const mime = imageMimeType(img.mimeType)
    if (
      typeof img.id !== 'string' ||
      !isSafeKanbanImageId(img.id) ||
      seen.has(img.id) ||
      !mime ||
      typeof img.size !== 'number' ||
      !Number.isSafeInteger(img.size) ||
      img.size < 1 ||
      (img.name !== undefined && typeof img.name !== 'string')
    ) {
      throw new Error('Invalid kanban image metadata')
    }
    seen.add(img.id)
    out.push({
      id: img.id,
      mimeType: mime,
      size: img.size,
      ...(img.name ? { name: img.name.slice(0, 200) } : {})
    })
  }
  return out
}

function parseSnapshot(text: string): KanbanSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Invalid kanban.json: malformed JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid kanban.json: root must be an object')
  }
  const file = raw as Partial<PersistedKanbanFile>
  if (
    (file.version !== undefined && file.version !== 1) ||
    typeof file.revision !== 'number' ||
    !Number.isSafeInteger(file.revision) ||
    file.revision < 0 ||
    typeof file.nextNumber !== 'number' ||
    !Number.isSafeInteger(file.nextNumber) ||
    file.nextNumber < 1 ||
    !Array.isArray(file.items)
  ) {
    throw new Error('Invalid kanban.json header')
  }

  const ids = new Set<string>()
  const numbers = new Set<number>()
  const items: KanbanIssue[] = []

  for (const entry of file.items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid kanban issue record')
    }
    const item = entry as Partial<KanbanIssue>
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.number !== 'number' ||
      !Number.isSafeInteger(item.number) ||
      item.number < 1 ||
      item.number >= file.nextNumber ||
      numbers.has(item.number) ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      typeof item.description !== 'string' ||
      !isKanbanStatus(item.status) ||
      !isKanbanPriority(item.priority) ||
      (item.projectCwd !== null && (typeof item.projectCwd !== 'string' || !item.projectCwd)) ||
      !Array.isArray(item.labels) ||
      item.labels.some((label) => typeof label !== 'string') ||
      typeof item.sortOrder !== 'number' ||
      !Number.isFinite(item.sortOrder) ||
      typeof item.createdAt !== 'number' ||
      !Number.isFinite(item.createdAt) ||
      typeof item.updatedAt !== 'number' ||
      !Number.isFinite(item.updatedAt) ||
      (item.completedAt !== null && (typeof item.completedAt !== 'number' || !Number.isFinite(item.completedAt)))
    ) {
      throw new Error('Invalid kanban issue fields')
    }
    const images = parseImagesMeta(item.images)
    const linkedSessionsRaw = item.linkedSessions ?? []
    const linkedBotTaskIdsRaw = item.linkedBotTaskIds ?? []
    if (
      !Array.isArray(linkedSessionsRaw) ||
      linkedSessionsRaw.some(
        (s) => !s || typeof s !== 'object' || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string'
      ) ||
      !Array.isArray(linkedBotTaskIdsRaw) ||
      linkedBotTaskIdsRaw.some((id) => typeof id !== 'string')
    ) {
      throw new Error('Invalid kanban issue links')
    }

    ids.add(item.id)
    numbers.add(item.number)
    items.push({
      id: item.id,
      number: item.number,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      projectCwd: item.projectCwd === null ? null : resolve(item.projectCwd),
      labels: [...item.labels],
      images,
      sortOrder: item.sortOrder,
      linkedSessions: linkedSessionsRaw.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })),
      linkedBotTaskIds: [...linkedBotTaskIdsRaw],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt
    })
  }

  return {
    revision: file.revision,
    nextNumber: file.nextNumber,
    items
  }
}

function broadcastKanbanChanged(snapshot: KanbanSnapshot): void {
  for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('kanban:changed', snapshot)
    }
  }
}

function topSortOrderForStatus(items: readonly KanbanIssue[], status: KanbanStatus): number {
  let min = Infinity
  for (const item of items) {
    if (item.status === status && item.sortOrder < min) min = item.sortOrder
  }
  return Number.isFinite(min) ? min - 1000 : 1000
}

export function filterKanbanIssues(items: readonly KanbanIssue[], filter: KanbanListFilter = {}): KanbanIssue[] {
  const statusSet = filter.status
    ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
    : null
  const needle = filter.query?.trim().toLowerCase() ?? ''
  const numberNeedle = needle.startsWith('#') ? Number(needle.slice(1)) : Number(needle)

  return items
    .filter((item) => {
      if (filter.projectCwd !== undefined && item.projectCwd !== filter.projectCwd) return false
      if (statusSet) {
        if (!statusSet.has(item.status)) return false
      } else {
        if (!filter.includeCanceled && item.status === 'canceled') return false
        if (filter.includeDone === false && item.status === 'done') return false
      }
      if (filter.priority && item.priority !== filter.priority) return false
      if (needle) {
        if (Number.isSafeInteger(numberNeedle) && item.number === numberNeedle) return true
        const haystacks = [
          `#${item.number}`,
          item.title.toLowerCase(),
          item.description.toLowerCase(),
          ...item.labels.map((l) => l.toLowerCase())
        ]
        if (!haystacks.some((text) => text.includes(needle))) return false
      }
      return true
    })
    .sort((a, b) => {
      const statusDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      if (statusDiff !== 0) return statusDiff
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      const prioDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      if (prioDiff !== 0) return prioDiff
      return b.number - a.number
    })
}

export class KanbanStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: () => string = () => pigPath('kanban.json'),
    private readonly onChanged: (snapshot: KanbanSnapshot) => void = broadcastKanbanChanged,
    private readonly imagesDir: () => string = () => join(dirname(this.file()), 'kanban-images')
  ) {}

  async getSnapshot(): Promise<KanbanSnapshot> {
    await this.queue
    return this.read()
  }

  async getByNumber(number: number): Promise<KanbanIssue | null> {
    if (!Number.isSafeInteger(number) || number < 1) return null
    const snapshot = await this.getSnapshot()
    return snapshot.items.find((item) => item.number === number) ?? null
  }

  async list(filter?: KanbanListFilter): Promise<KanbanIssue[]> {
    const snapshot = await this.getSnapshot()
    return filterKanbanIssues(snapshot.items, filter)
  }

  async readImage(imageId: string): Promise<{ data: Buffer; mimeType: string } | null> {
    if (!isSafeKanbanImageId(imageId)) return null
    const snapshot = await this.getSnapshot()
    let found: KanbanImageAttachment | undefined
    for (const issue of snapshot.items) {
      found = issue.images.find((img) => img.id === imageId)
      if (found) break
    }
    if (!found) return null
    try {
      const data = await readFile(join(this.imagesDir(), found.id))
      return data.length > 0 ? { data, mimeType: found.mimeType } : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async readIssueImageBlocks(issue: KanbanIssue): Promise<Array<{ mimeType: string; data: string }>> {
    if (issue.images.length === 0) return []
    const blocks: Array<{ mimeType: string; data: string }> = []
    for (const img of issue.images) {
      try {
        const bytes = await readFile(join(this.imagesDir(), img.id))
        if (bytes.length > 0) {
          blocks.push({ mimeType: img.mimeType, data: bytes.toString('base64') })
        }
      } catch {
        // Missing image file on disk degrades gracefully without breaking kanban_get.
      }
    }
    return blocks
  }

  async formatIssueForClipboard(number: number, imagesHeading: string): Promise<string> {
    const issue = await this.getByNumber(number)
    if (!issue) throw new Error(`Issue #${number} not found`)
    const dir = resolve(this.imagesDir())
    const imagePaths: string[] = []
    for (const img of issue.images) {
      const rawPath = join(dir, img.id)
      if (img.id.includes('.')) {
        imagePaths.push(rawPath)
        continue
      }
      const withExt = `${rawPath}.${kanbanImageExtension(img.mimeType)}`
      try {
        const existing = await stat(withExt).catch(() => null)
        if (!existing) {
          await link(rawPath, withExt).catch(() => copyFile(rawPath, withExt))
        }
        imagePaths.push(withExt)
      } catch {
        imagePaths.push(rawPath)
      }
    }
    return formatKanbanIssueClipboardText({
      title: issue.title,
      description: issue.description,
      imagePaths,
      imagesHeading
    })
  }

  private async read(): Promise<KanbanSnapshot> {
    try {
      return parseSnapshot(await readFile(this.file(), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { revision: 0, nextNumber: 1, items: [] }
      }
      throw error
    }
  }

  private async write(snapshot: KanbanSnapshot): Promise<void> {
    const target = this.file()
    const temp = `${target}.${randomUUID()}.tmp`
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const payload: PersistedKanbanFile = {
      version: 1,
      revision: snapshot.revision,
      nextNumber: snapshot.nextNumber,
      items: snapshot.items
    }
    try {
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temp, target)
    } finally {
      await rm(temp, { force: true })
    }
  }

  private async prepareImages(
    inputs: readonly KanbanImageInput[] | undefined,
    existing: readonly KanbanImageAttachment[]
  ): Promise<{
    attachments: KanbanImageAttachment[]
    writtenFiles: string[]
    removedIds: string[]
  }> {
    if (inputs === undefined) {
      return { attachments: [...existing], writtenFiles: [], removedIds: [] }
    }
    if (!Array.isArray(inputs)) {
      throw new Error('Issue images must be an array')
    }
    if (inputs.length > MAX_IMAGES_PER_ISSUE) {
      throw new Error(`At most ${MAX_IMAGES_PER_ISSUE} images are allowed per issue`)
    }

    const existingById = new Map(existing.map((img) => [img.id, img]))
    const attachments: KanbanImageAttachment[] = []
    const writtenFiles: string[] = []
    const retainedIds = new Set<string>()
    const dir = this.imagesDir()

    try {
      for (const raw of inputs) {
        if (!raw || typeof raw !== 'object') {
          throw new Error('Invalid image input')
        }
        if (!('data' in raw) || raw.data === undefined) {
          const prev = typeof raw.id === 'string' ? existingById.get(raw.id) : undefined
          if (!prev) throw new Error('Referenced image does not exist on this issue')
          if (!retainedIds.has(prev.id)) {
            retainedIds.add(prev.id)
            attachments.push(prev)
          }
          continue
        }

        const mime = imageMimeType(raw.mimeType)
        const body = base64Body(raw.data)
        if (!mime || !body) {
          throw new Error('Invalid image payload')
        }
        const bytes = Buffer.from(body, 'base64')
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
          throw new Error(`Image size must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`)
        }
        const id = `${randomUUID()}.${kanbanImageExtension(mime)}`
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const filePath = join(dir, id)
        await writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' })
        writtenFiles.push(filePath)
        attachments.push({
          id,
          mimeType: mime,
          size: bytes.length,
          ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim().slice(0, 200) } : {})
        })
      }
    } catch (error) {
      await Promise.all(writtenFiles.map((path) => rm(path, { force: true })))
      throw error
    }

    const removedIds = existing
      .filter((img) => !retainedIds.has(img.id))
      .map((img) => img.id)

    return { attachments, writtenFiles, removedIds }
  }

  private mutateAsync<T>(
    change: (current: KanbanSnapshot) => Promise<{
      snapshot: KanbanSnapshot
      result: T
      changed: boolean
      rollbackFiles?: string[]
      cleanupIds?: string[]
    }>
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const current = await this.read()
      const { snapshot, result, changed, rollbackFiles = [], cleanupIds = [] } = await change(current)
      if (!changed) return result
      try {
        await this.write(snapshot)
      } catch (error) {
        await Promise.all(rollbackFiles.map((path) => rm(path, { force: true })))
        throw error
      }
      if (cleanupIds.length > 0) {
        const dir = this.imagesDir()
        const targets = cleanupIds.flatMap((id) =>
          id.includes('.')
            ? [join(dir, id)]
            : [
                join(dir, id),
                join(dir, `${id}.png`),
                join(dir, `${id}.jpg`),
                join(dir, `${id}.webp`),
                join(dir, `${id}.gif`)
              ]
        )
        await Promise.all(targets.map((filePath) => rm(filePath, { force: true }).catch(() => {})))
      }
      this.onChanged(snapshot)
      return result
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  create(input: KanbanCreateInput): Promise<{ issue: KanbanIssue; snapshot: KanbanSnapshot }> {
    return this.mutateAsync(async (current) => {
      const title = normalizeTitle(input.title)
      const description = normalizeDescription(input.description)
      const status: KanbanStatus = input.status ?? 'todo'
      if (!isKanbanStatus(status)) throw new Error('Invalid issue status')
      const priority: KanbanPriority = input.priority ?? 'none'
      if (!isKanbanPriority(priority)) throw new Error('Invalid issue priority')
      const projectCwd = normalizeProjectCwd(input.projectCwd)
      const labels = normalizeLabels(input.labels)
      const prepared = await this.prepareImages(input.images, [])
      const now = Date.now()
      const issue: KanbanIssue = {
        id: randomUUID(),
        number: current.nextNumber,
        title,
        description,
        status,
        priority,
        projectCwd,
        labels,
        images: prepared.attachments,
        sortOrder: topSortOrderForStatus(current.items, status),
        linkedSessions: [],
        linkedBotTaskIds: [],
        createdAt: now,
        updatedAt: now,
        completedAt: status === 'done' ? now : null
      }
      const snapshot: KanbanSnapshot = {
        revision: current.revision + 1,
        nextNumber: current.nextNumber + 1,
        items: [issue, ...current.items]
      }
      return {
        snapshot,
        result: { issue, snapshot },
        changed: true,
        rollbackFiles: prepared.writtenFiles
      }
    })
  }

  update(input: KanbanUpdateInput): Promise<{ issue: KanbanIssue; snapshot: KanbanSnapshot }> {
    return this.mutateAsync(async (current) => {
      if (!Number.isSafeInteger(input.number) || input.number < 1) {
        throw new Error('Invalid issue number')
      }
      const index = current.items.findIndex((item) => item.number === input.number)
      if (index < 0) throw new Error(`Issue #${input.number} not found`)
      const prev = current.items[index]

      const title = input.title !== undefined ? normalizeTitle(input.title) : prev.title
      const description = input.description !== undefined ? normalizeDescription(input.description) : prev.description
      const status = input.status !== undefined ? input.status : prev.status
      if (!isKanbanStatus(status)) throw new Error('Invalid issue status')
      const priority = input.priority !== undefined ? input.priority : prev.priority
      if (!isKanbanPriority(priority)) throw new Error('Invalid issue priority')
      const projectCwd = input.projectCwd !== undefined ? normalizeProjectCwd(input.projectCwd) : prev.projectCwd
      const labels = input.labels !== undefined ? normalizeLabels(input.labels) : prev.labels

      let sortOrder = prev.sortOrder
      if (input.sortOrder !== undefined) {
        if (typeof input.sortOrder !== 'number' || !Number.isFinite(input.sortOrder)) {
          throw new Error('Invalid issue sortOrder')
        }
        sortOrder = input.sortOrder
      } else if (status !== prev.status) {
        sortOrder = topSortOrderForStatus(current.items, status)
      }

      const prepared = await this.prepareImages(input.images, prev.images)
      const imagesChanged =
        prepared.writtenFiles.length > 0 ||
        prepared.removedIds.length > 0 ||
        prepared.attachments.length !== prev.images.length ||
        prepared.attachments.some((img, i) => img.id !== prev.images[i]?.id)

      const unchanged =
        !imagesChanged &&
        title === prev.title &&
        description === prev.description &&
        status === prev.status &&
        priority === prev.priority &&
        projectCwd === prev.projectCwd &&
        sortOrder === prev.sortOrder &&
        labels.length === prev.labels.length &&
        labels.every((label, i) => label === prev.labels[i])

      if (unchanged) {
        return { snapshot: current, result: { issue: prev, snapshot: current }, changed: false }
      }

      const now = Date.now()
      let completedAt = prev.completedAt
      if (status === 'done' && prev.status !== 'done') completedAt = now
      else if (status !== 'done' && status !== 'canceled') completedAt = null

      const updated: KanbanIssue = {
        ...prev,
        title,
        description,
        status,
        priority,
        projectCwd,
        labels,
        images: prepared.attachments,
        sortOrder,
        updatedAt: now,
        completedAt
      }
      const items = [...current.items]
      items[index] = updated
      const snapshot: KanbanSnapshot = {
        revision: current.revision + 1,
        nextNumber: current.nextNumber,
        items
      }
      return {
        snapshot,
        result: { issue: updated, snapshot },
        changed: true,
        rollbackFiles: prepared.writtenFiles,
        cleanupIds: prepared.removedIds
      }
    })
  }

  delete(number: number): Promise<KanbanSnapshot> {
    return this.mutateAsync(async (current) => {
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error('Invalid issue number')
      }
      const existing = current.items.find((item) => item.number === number)
      if (!existing) {
        throw new Error(`Issue #${number} not found`)
      }
      const snapshot: KanbanSnapshot = {
        revision: current.revision + 1,
        nextNumber: current.nextNumber,
        items: current.items.filter((item) => item.number !== number)
      }
      return {
        snapshot,
        result: snapshot,
        changed: true,
        cleanupIds: existing.images.map((img) => img.id)
      }
    })
  }

  linkSession(numbers: readonly number[], session: KanbanLinkedSession): Promise<KanbanSnapshot | null> {
    const targetNumbers = new Set(numbers.filter((n) => Number.isSafeInteger(n) && n >= 1))
    if (targetNumbers.size === 0 || !session.sessionId) return Promise.resolve(null)
    return this.mutateAsync(async (current) => {
      let mutated = false
      const items = current.items.map((item) => {
        if (!targetNumbers.has(item.number)) return item
        if (item.linkedSessions.some((entry) => entry.sessionId === session.sessionId)) return item
        mutated = true
        return {
          ...item,
          linkedSessions: [...item.linkedSessions, { sessionId: session.sessionId, cwd: session.cwd }]
        }
      })
      if (!mutated) return { snapshot: current, result: null, changed: false }
      const snapshot: KanbanSnapshot = {
        revision: current.revision + 1,
        nextNumber: current.nextNumber,
        items
      }
      return { snapshot, result: snapshot, changed: true }
    })
  }

  linkBotTask(numbers: readonly number[], taskId: string): Promise<KanbanSnapshot | null> {
    const targetNumbers = new Set(numbers.filter((n) => Number.isSafeInteger(n) && n >= 1))
    if (targetNumbers.size === 0 || !taskId) return Promise.resolve(null)
    return this.mutateAsync(async (current) => {
      let mutated = false
      const items = current.items.map((item) => {
        if (!targetNumbers.has(item.number)) return item
        if (item.linkedBotTaskIds.includes(taskId)) return item
        mutated = true
        return {
          ...item,
          linkedBotTaskIds: [...item.linkedBotTaskIds, taskId]
        }
      })
      if (!mutated) return { snapshot: current, result: null, changed: false }
      const snapshot: KanbanSnapshot = {
        revision: current.revision + 1,
        nextNumber: current.nextNumber,
        items
      }
      return { snapshot, result: snapshot, changed: true }
    })
  }

  relocateLinkedSessions(sessionIds: readonly string[], nextCwd: string): Promise<KanbanSnapshot | null> {
    const ids = new Set(sessionIds.filter(Boolean))
    if (ids.size === 0 || !nextCwd) return Promise.resolve(null)
    const normalizedCwd = resolve(nextCwd)
    return this.mutateAsync(async (current) => {
      let mutated = false
      const items = current.items.map((item) => {
        if (!item.linkedSessions.some((entry) => ids.has(entry.sessionId) && entry.cwd !== normalizedCwd)) {
          return item
        }
        mutated = true
        return {
          ...item,
          linkedSessions: item.linkedSessions.map((entry) =>
            ids.has(entry.sessionId) ? { ...entry, cwd: normalizedCwd } : entry
          )
        }
      })
      if (!mutated) return { snapshot: current, result: null, changed: false }
      const snapshot: KanbanSnapshot = {
        revision: current.revision + 1,
        nextNumber: current.nextNumber,
        items
      }
      return { snapshot, result: snapshot, changed: true }
    })
  }
}

export const kanban = new KanbanStore()

export async function kanbanImageResponse(url: string): Promise<Response> {
  const imageId = parseKanbanImageUrl(url)
  if (!imageId) return new Response(null, { status: 404 })
  const loaded = await kanban.readImage(imageId)
  if (!loaded) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(loaded.data), {
    headers: {
      'content-type': loaded.mimeType,
      'cache-control': 'private, max-age=31536000, immutable'
    }
  })
}

/**
 * Resolves a session's working directory to its canonical opened project root cwd,
 * or null when the session is a standalone Chat or outside registered projects.
 */
export async function resolveSessionProjectRoot(cwd: string | undefined): Promise<string | null> {
  if (!cwd || isChatCwd(cwd)) return null
  const normalized = resolve(cwd)
  const opened = await listOpenedCwds()
  if (opened.includes(normalized)) return normalized
  for (const projectCwd of opened) {
    const branches = await worktrees.discover(projectCwd).catch(() => [])
    if (branches.some((branch) => resolve(branch.cwd) === normalized)) {
      return projectCwd
    }
  }
  return null
}
