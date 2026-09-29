import { open, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import type { ProjectGroup, SessionMeta, SessionNameUpdate } from '../../shared/api'
import { stripImageHintsFromContent } from '../../shared/image-hints'
import { compareGroupsByLatestSession } from '../../shared/session-order'
import { t } from '../i18n'

export type { ProjectGroup, SessionMeta } from '../../shared/api'

const PREFIX_BYTES = 64 * 1024
/** Names are appended, so finding the newest one means walking the file back in reads this large. */
const NAME_READ_BYTES = 4 * 1024 * 1024
const NAME_FLUSH_MS = 50
const SCAN_CONCURRENCY = 32

function sessionsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  return join(agentDir, 'sessions')
}

export function sessionDirForCwd(cwd: string): string {
  const resolved = resolve(cwd)
  const safePath = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(sessionsRoot(), safePath)
}

export function isSessionFile(path: string): boolean {
  const root = resolve(sessionsRoot()) + sep
  const resolved = resolve(path)
  return resolved.startsWith(root) && resolved.endsWith('.jsonl')
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

async function readPrefix(filePath: string): Promise<string[]> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(PREFIX_BYTES)
    const { bytesRead } = await handle.read(buf, 0, PREFIX_BYTES, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return text.split('\n')
  } finally {
    await handle.close()
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text?: string } => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('')
}

function hasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((block) => block?.type === 'image')
}

function readJsonString(source: string, quoteIndex: number): string {
  let i = quoteIndex + 1
  let out = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"') return out
    if (ch !== '\\') {
      out += ch
      i++
      continue
    }
    if (i + 1 >= source.length) return out
    const next = source[i + 1]
    if (next === 'u' && i + 6 <= source.length) {
      out += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16))
      i += 6
      continue
    }
    const escaped =
      next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next === 'b' ? '\b' : next === 'f' ? '\f' : next
    out += escaped
    i += 2
  }
  return out
}

function truncatedText(line: string): string {
  let from = 0
  while (from < line.length) {
    const key = line.indexOf('"text"', from)
    if (key === -1) return ''
    let i = key + 6
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
    if (line[i] !== ':') {
      from = key + 1
      continue
    }
    i++
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
    if (line[i] !== '"') {
      from = key + 1
      continue
    }
    const value = readJsonString(line, i)
    if (value.trim()) return value
    from = key + 1
  }
  return ''
}

type ScanEntry = {
  type?: string
  id?: string
  timestamp?: string
  cwd?: string
  name?: string
  message?: { role?: string; content?: unknown }
}

function parseEntry(line: string): ScanEntry | null {
  try {
    return JSON.parse(line) as ScanEntry
  } catch {
    const type = line.match(/"type"\s*:\s*"([^"]+)"/)?.[1]
    if (type === 'session_info') {
      const quote = line.search(/"name"\s*:\s*"/)
      if (quote === -1) return { type }
      const start = line.indexOf('"', line.indexOf(':', quote))
      return { type, name: start === -1 ? undefined : readJsonString(line, start).trim() || undefined }
    }
    if (type !== 'message') return type ? { type } : null
    const role = line.match(/"role"\s*:\s*"([^"]+)"/)?.[1]
    const text = truncatedText(line)
    const content: Array<{ type: string; text?: string }> = []
    if (text) content.push({ type: 'text', text })
    if (/"type"\s*:\s*"image"/.test(line)) content.push({ type: 'image' })
    return { type, message: { role, content } }
  }
}

/**
 * The row's title falls back to the first user message with text. Images on their own are a fact
 * rather than copy, so they are reported as a flag and the renderer picks the word: a scanned
 * placeholder would freeze in whichever language happened to be active when the listing ran.
 */
function previewText(content: unknown): { text: string; image: boolean } {
  const text = contentText(stripImageHintsFromContent(content)).trim()
  if (text) return { text: text.slice(0, 500), image: false }
  return { text: '', image: hasImage(content) }
}

type NameScan = { sessionId: string; path: string; size: number; dropped?: boolean }

/**
 * What the prefix scan cannot answer: a name is appended to the end of a session file, which for a long
 * session is megabytes past the prefix a listing reads. Those files are scanned in the background, once
 * per run, and the windows showing the row learn the answer through `onSessionNamesResolved`. A file
 * that had no name is remembered as such: appending can only add one, so nothing but a rename has to
 * forget the entry again.
 */
const sessionNames = new Map<string, string | undefined>()
const nameScans: NameScan[] = []
const nameListeners = new Set<(updates: SessionNameUpdate[]) => void>()
let scanningNames = false
let currentScan: NameScan | null = null
let pendingNames: SessionNameUpdate[] = []
let nameFlush: ReturnType<typeof setTimeout> | null = null

export function onSessionNamesResolved(listener: (updates: SessionNameUpdate[]) => void): () => void {
  nameListeners.add(listener)
  return () => {
    nameListeners.delete(listener)
  }
}

/** A rename just appended a name, so a scan still running would report the name it replaced. */
export function forgetSessionName(path: string): void {
  sessionNames.delete(path)
  const queued = nameScans.findIndex((scan) => scan.path === path)
  if (queued >= 0) nameScans.splice(queued, 1)
  if (currentScan?.path === path) currentScan.dropped = true
}

function flushNames(): void {
  nameFlush = null
  const updates = pendingNames
  pendingNames = []
  for (const listener of nameListeners) listener(updates)
}

async function drainNameScans(): Promise<void> {
  if (scanningNames) return
  scanningNames = true
  try {
    for (let scan = nameScans.shift(); scan; scan = nameScans.shift()) {
      currentScan = scan
      const name = await findSessionName(scan.path, scan.size).catch(() => undefined)
      currentScan = null
      if (scan.dropped) continue
      sessionNames.set(scan.path, name)
      if (name) {
        pendingNames.push({ sessionId: scan.sessionId, path: scan.path, name })
        if (nameFlush === null) nameFlush = setTimeout(flushNames, NAME_FLUSH_MS)
      }
      // The listing that queued this is answered already: the rest of the queue waits for a free tick.
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    scanningNames = false
  }
}

function sessionNameOf(sessionId: string, path: string, size: number): string | undefined {
  if (sessionNames.has(path)) return sessionNames.get(path)
  if (!nameScans.some((scan) => scan.path === path)) {
    nameScans.push({ sessionId, path, size })
    void drainNameScans()
  }
  return undefined
}

/**
 * The name the SDK would report for a session file: the newest `session_info` entry, an empty one
 * counting as cleared. Reads walk back from the end a chunk at a time and stop at the first entry they
 * meet, so a name costs what the bytes behind it cost. Lines a reader skips are walked over, and a line
 * cut in half by a chunk boundary waits for the bytes in front of it.
 */
async function findSessionName(filePath: string, size: number): Promise<string | undefined> {
  const handle = await open(filePath, 'r')
  try {
    let cursor = size
    let carry: string | null = null
    while (cursor > 0) {
      const start = Math.max(0, cursor - NAME_READ_BYTES)
      const buf = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(buf, 0, buf.length, start)
      const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
      // The head of a line that starts before this chunk completes the tail carried from the last one.
      if (carry !== null) lines[lines.length - 1] += carry
      carry = start > 0 ? (lines.shift() ?? '') : null
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]
        if (!line.trim()) continue
        const entry = parseEntry(line)
        if (entry?.type === 'session_info') return entry.name?.trim() || undefined
      }
      cursor = start
    }
    return undefined
  } finally {
    await handle.close()
  }
}

async function scanFile(filePath: string, deep: boolean): Promise<SessionMeta | null> {
  try {
    const [st, lines] = await Promise.all([stat(filePath), readPrefix(filePath)])
    let id = ''
    let cwd = ''
    let created = st.birthtime.toISOString()
    let name: string | undefined
    let firstMessage = ''
    let firstMessageIsImage = false

    for (const line of lines) {
      if (!line.trim()) continue
      const entry = parseEntry(line)
      if (!entry) continue
      if (!id && entry.type === 'session' && typeof entry.id === 'string') {
        id = entry.id
        cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
        if (typeof entry.timestamp === 'string') {
          const time = new Date(entry.timestamp)
          if (!Number.isNaN(time.getTime())) created = time.toISOString()
        }
        continue
      }
      if (entry.type === 'session_info') {
        name = entry.name?.trim() || undefined
        continue
      }
      if (entry.type !== 'message') continue
      if (entry.message?.role !== 'user') continue
      if (!firstMessage) {
        const preview = previewText(entry.message.content)
        firstMessage = preview.text
        firstMessageIsImage = preview.image
      }
    }

    if (!id) return null
    // Past the prefix the name can still be there, appended long after the first message was written.
    const resolved = !name && deep && st.size > PREFIX_BYTES ? sessionNameOf(id, filePath, st.size) : name
    return {
      path: filePath,
      id,
      cwd,
      name: resolved,
      created,
      modified: st.mtime.toISOString(),
      size: st.size,
      firstMessage,
      firstMessageIsImage: firstMessageIsImage || undefined
    }
  } catch {
    return null
  }
}

export async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

async function scanFiles(files: string[], options: { deep?: boolean } = {}): Promise<SessionMeta[]> {
  if (files.length === 0) return []
  const deep = options.deep ?? true
  const metas = await mapPool(files, SCAN_CONCURRENCY, (file) => scanFile(file, deep))
  return metas.filter((meta): meta is SessionMeta => meta !== null)
}

function projectGroup(cwd: string, sessions: SessionMeta[]): ProjectGroup {
  const resolved = cwd === '(unknown)' ? cwd : resolve(cwd)
  return {
    cwd: resolved,
    name: resolved === '(unknown)' ? t('sessions.unknownProject') : basename(resolved) || resolved,
    sessions: [...sessions].sort((a, b) => b.modified.localeCompare(a.modified))
  }
}

async function collectAllFiles(): Promise<string[]> {
  const root = sessionsRoot()
  try {
    const dirs = await readdir(root, { withFileTypes: true })
    const groups = await Promise.all(
      dirs.filter((entry) => entry.isDirectory()).map((entry) => listJsonlFiles(join(root, entry.name)))
    )
    return groups.flat()
  } catch {
    return []
  }
}

export async function listProject(cwd: string): Promise<ProjectGroup | null> {
  if (cwd === '(unknown)') {
    const metas = (await scanFiles(await collectAllFiles())).filter((meta) => !meta.cwd)
    return metas.length === 0 ? null : projectGroup(cwd, metas)
  }
  const resolved = resolve(cwd)
  const metas = (await scanFiles(await listJsonlFiles(sessionDirForCwd(resolved)))).filter(
    (meta) => !meta.cwd || resolve(meta.cwd) === resolved
  )
  return projectGroup(resolved, metas)
}

export async function listProjects(): Promise<ProjectGroup[]> {
  // Every session of every project: the project tree sorts by newest activity, so names are not worth
  // walking long files for here.
  const metas = await scanFiles(await collectAllFiles(), { deep: false })
  const byCwd = new Map<string, SessionMeta[]>()
  for (const meta of metas) {
    const cwd = meta.cwd || '(unknown)'
    const arr = byCwd.get(cwd)
    if (arr) arr.push(meta)
    else byCwd.set(cwd, [meta])
  }

  const groups = [...byCwd].map(([cwd, sessions]) => projectGroup(cwd, sessions))
  groups.sort(compareGroupsByLatestSession)
  return groups
}

export async function listProjectFiles(cwd: string): Promise<string[]> {
  if (cwd === '(unknown)') {
    // Only the paths are wanted here: names are not worth walking long files for.
    return (await scanFiles(await collectAllFiles(), { deep: false })).filter((meta) => !meta.cwd).map((meta) => meta.path)
  }
  return listJsonlFiles(sessionDirForCwd(cwd))
}

export async function removeSessionFile(path: string): Promise<void> {
  if (!isSessionFile(path)) throw new Error(`Invalid session path: ${path}`)
  await rm(path, { force: true })
}

export async function removeProjectDir(cwd: string): Promise<void> {
  if (cwd === '(unknown)') {
    const files = await listProjectFiles(cwd)
    await Promise.all(files.map((path) => removeSessionFile(path)))
    return
  }
  const dir = resolve(sessionDirForCwd(cwd))
  const root = resolve(sessionsRoot()) + sep
  if (!dir.startsWith(root)) throw new Error(`Invalid project dir: ${dir}`)
  const target = resolve(cwd)
  const sessions = await scanFiles(await listJsonlFiles(dir), { deep: false })
  await Promise.all(sessions
    .filter((session) => session.cwd && resolve(session.cwd) === target)
    .map((session) => removeSessionFile(session.path)))
  try {
    await rmdir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
  }
}
