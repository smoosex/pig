/**
 * Atomic JSON store for Project Spaces (`$PIG_DIR/project-spaces.json`).
 * Serializes all reads and writes on one queue, increments `revision` monotonically,
 * and refuses to overwrite corrupt or unreadable files with defaults.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_SPACE_ID,
  createDefaultSpacesSnapshot,
  fallbackSpaceId,
  isProjectSpaceIcon,
  type CreateProjectSpaceInput,
  type ProjectSpace,
  type ProjectSpaceIcon,
  type ProjectSpacesSnapshot,
  type UpdateProjectSpaceInput
} from '../shared/project-spaces'
import { pigPath } from './pig-dir'

const MAX_SPACE_NAME_LENGTH = 80
const MAX_SPACE_ID_LENGTH = 120

function normalizeSpaceIcon(icon: unknown): ProjectSpaceIcon | undefined {
  if (icon === undefined || icon === null || icon === 'dot') return undefined
  if (!isProjectSpaceIcon(icon)) throw new Error('Invalid space icon')
  return icon
}

function normalizeSpaceName(raw: unknown, allowEmpty: boolean): string {
  if (typeof raw !== 'string') throw new Error('Invalid space name')
  const trimmed = raw.replace(/[\r\n]+/g, ' ').trim()
  if (!allowEmpty && !trimmed) throw new Error('Space name cannot be empty')
  if (trimmed.length > MAX_SPACE_NAME_LENGTH) throw new Error('Space name is too long')
  return trimmed
}

function parseSnapshot(text: string): ProjectSpacesSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Invalid project spaces file')
  }
  if (!raw || typeof raw !== 'object') throw new Error('Invalid project spaces file')
  const data = raw as Record<string, unknown>
  if (
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 0 ||
    typeof data.activeSpaceId !== 'string' ||
    !Array.isArray(data.spaces) ||
    data.spaces.length === 0 ||
    !data.assignments ||
    typeof data.assignments !== 'object' ||
    Array.isArray(data.assignments)
  ) {
    throw new Error('Invalid project spaces file')
  }

  const ids = new Set<string>()
  const spaces: ProjectSpace[] = []
  for (const entry of data.spaces) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid project space record')
    const record = entry as Record<string, unknown>
    if (
      typeof record.id !== 'string' ||
      !record.id ||
      record.id.length > MAX_SPACE_ID_LENGTH ||
      ids.has(record.id) ||
      typeof record.name !== 'string' ||
      record.name.length > MAX_SPACE_NAME_LENGTH
    ) {
      throw new Error('Invalid project space record')
    }
    const icon = normalizeSpaceIcon(record.icon)
    ids.add(record.id)
    spaces.push({
      id: record.id,
      name: record.name,
      ...(icon ? { icon } : {})
    })
  }

  const activeSpaceId = ids.has(data.activeSpaceId) ? data.activeSpaceId : fallbackSpaceId(spaces)
  const assignments: Record<string, string> = {}
  for (const [cwd, spaceId] of Object.entries(data.assignments as Record<string, unknown>)) {
    if (!cwd || typeof spaceId !== 'string') throw new Error('Invalid project space assignment')
    if (ids.has(spaceId)) {
      assignments[resolve(cwd)] = spaceId
    }
  }

  return {
    revision: data.revision as number,
    activeSpaceId,
    spaces,
    assignments
  }
}

export class ProjectSpaceStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: () => string = () => pigPath('project-spaces.json')) {}

  async getSnapshot(): Promise<ProjectSpacesSnapshot> {
    await this.queue
    return this.read()
  }

  private async read(): Promise<ProjectSpacesSnapshot> {
    try {
      return parseSnapshot(await readFile(this.file(), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createDefaultSpacesSnapshot()
      }
      throw error
    }
  }

  private mutate(
    change: (current: ProjectSpacesSnapshot) => Omit<ProjectSpacesSnapshot, 'revision'> | null
  ): Promise<ProjectSpacesSnapshot> {
    const operation = this.queue.then(async () => {
      const previous = await this.read()
      const updated = change(previous)
      if (!updated) return previous
      const next: ProjectSpacesSnapshot = {
        revision: previous.revision + 1,
        activeSpaceId: updated.activeSpaceId,
        spaces: updated.spaces,
        assignments: updated.assignments
      }
      const file = this.file()
      const temp = `${file}.${randomUUID()}.tmp`
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temp, file)
      } finally {
        await rm(temp, { force: true })
      }
      return next
    })
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  select(spaceId: string): Promise<ProjectSpacesSnapshot> {
    if (typeof spaceId !== 'string' || !spaceId) throw new Error('Invalid space identifier')
    return this.mutate((current) => {
      if (!current.spaces.some((space) => space.id === spaceId)) {
        throw new Error('Space not found')
      }
      if (current.activeSpaceId === spaceId) return null
      return {
        ...current,
        activeSpaceId: spaceId
      }
    })
  }

  create(input: CreateProjectSpaceInput): Promise<ProjectSpacesSnapshot> {
    if (!input || typeof input !== 'object') throw new Error('Invalid space input')
    const name = normalizeSpaceName(input.name, false)
    const icon = normalizeSpaceIcon(input.icon)
    const moveProjectCwd =
      typeof input.moveProjectCwd === 'string' && input.moveProjectCwd
        ? resolve(input.moveProjectCwd)
        : undefined
    const activate = input.activate !== false

    return this.mutate((current) => {
      const id = randomUUID()
      const created: ProjectSpace = {
        id,
        name,
        ...(icon ? { icon } : {})
      }
      const assignments = moveProjectCwd
        ? { ...current.assignments, [moveProjectCwd]: id }
        : current.assignments
      return {
        activeSpaceId: activate ? id : current.activeSpaceId,
        spaces: [...current.spaces, created],
        assignments
      }
    })
  }

  update(input: UpdateProjectSpaceInput): Promise<ProjectSpacesSnapshot> {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !input.id) {
      throw new Error('Invalid space identifier')
    }
    return this.mutate((current) => {
      const index = current.spaces.findIndex((space) => space.id === input.id)
      if (index === -1) throw new Error('Space not found')
      const existing = current.spaces[index]!
      const nextName =
        input.name !== undefined
          ? normalizeSpaceName(input.name, existing.id === DEFAULT_SPACE_ID)
          : existing.name
      const nextIcon = input.icon !== undefined ? normalizeSpaceIcon(input.icon) : existing.icon
      if (nextName === existing.name && nextIcon === existing.icon) return null
      const spaces = [...current.spaces]
      spaces[index] = {
        id: existing.id,
        name: nextName,
        ...(nextIcon ? { icon: nextIcon } : {})
      }
      return {
        ...current,
        spaces
      }
    })
  }

  remove(id: string): Promise<ProjectSpacesSnapshot> {
    if (typeof id !== 'string' || !id) throw new Error('Invalid space identifier')
    return this.mutate((current) => {
      const index = current.spaces.findIndex((space) => space.id === id)
      if (index === -1) throw new Error('Space not found')
      if (current.spaces.length <= 1) throw new Error('Cannot delete the last space')

      const spaces = current.spaces.filter((space) => space.id !== id)
      const targetId = fallbackSpaceId(spaces)
      const assignments: Record<string, string> = {}
      for (const [cwd, assigned] of Object.entries(current.assignments)) {
        const effective = assigned === id ? targetId : assigned
        if (effective !== targetId || targetId !== DEFAULT_SPACE_ID) {
          assignments[cwd] = effective
        }
      }
      const activeSpaceId =
        current.activeSpaceId === id
          ? (spaces[Math.min(index, spaces.length - 1)]?.id ?? targetId)
          : current.activeSpaceId

      return {
        activeSpaceId,
        spaces,
        assignments
      }
    })
  }

  assignProject(cwd: string, spaceId: string): Promise<ProjectSpacesSnapshot> {
    if (typeof cwd !== 'string' || !cwd) throw new Error('Project cwd is required')
    if (typeof spaceId !== 'string' || !spaceId) throw new Error('Invalid space identifier')
    const resolved = resolve(cwd)
    return this.mutate((current) => {
      if (!current.spaces.some((space) => space.id === spaceId)) {
        throw new Error('Space not found')
      }
      const fallback = fallbackSpaceId(current.spaces)
      const currentSpace = current.assignments[resolved] ?? fallback
      if (currentSpace === spaceId) return null
      const assignments = { ...current.assignments }
      if (spaceId === fallback && fallback === DEFAULT_SPACE_ID) {
        delete assignments[resolved]
      } else {
        assignments[resolved] = spaceId
      }
      return {
        ...current,
        assignments
      }
    })
  }

  forgetProject(cwd: string): Promise<ProjectSpacesSnapshot> {
    if (typeof cwd !== 'string' || !cwd) throw new Error('Project cwd is required')
    const resolved = resolve(cwd)
    return this.mutate((current) => {
      if (!(resolved in current.assignments)) return null
      const assignments = { ...current.assignments }
      delete assignments[resolved]
      return {
        ...current,
        assignments
      }
    })
  }

  relocateProject(oldCwd: string, nextCwd: string): Promise<ProjectSpacesSnapshot> {
    const source = resolve(oldCwd)
    const target = resolve(nextCwd)
    if (source === target) return this.getSnapshot()
    return this.mutate((current) => {
      const assigned = current.assignments[source]
      if (!assigned) return null
      const assignments = { ...current.assignments }
      if (!assignments[target]) {
        assignments[target] = assigned
      }
      delete assignments[source]
      return {
        ...current,
        assignments
      }
    })
  }
}

export const projectSpaces = new ProjectSpaceStore()
