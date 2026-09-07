import { open, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

export interface SessionMeta {
  path: string
  id: string
  cwd: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
}

export interface ProjectGroup {
  cwd: string
  name: string
  sessions: SessionMeta[]
}

const PREFIX_BYTES = 64 * 1024
const SCAN_CONCURRENCY = 32
const IMAGE_PREVIEW = '图片'

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
    const value = readJsonString(line, i).trim()
    if (value) return value
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

function previewText(content: unknown): string {
  const text = contentText(content).trim()
  if (text) return text.slice(0, 500)
  return hasImage(content) ? IMAGE_PREVIEW : ''
}

async function scanFile(filePath: string): Promise<SessionMeta | null> {
  try {
    const [st, lines] = await Promise.all([stat(filePath), readPrefix(filePath)])
    let id = ''
    let cwd = ''
    let created = st.birthtime.toISOString()
    let name: string | undefined
    let firstMessage = ''
    let messageCount = 0

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
      messageCount++
      if (firstMessage || entry.message?.role !== 'user') continue
      firstMessage = previewText(entry.message.content)
    }

    if (!id) return null
    return {
      path: filePath,
      id,
      cwd,
      name,
      created,
      modified: st.mtime.toISOString(),
      messageCount,
      firstMessage
    }
  } catch {
    return null
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

async function scanFiles(files: string[]): Promise<SessionMeta[]> {
  if (files.length === 0) return []
  const metas = await mapPool(files, SCAN_CONCURRENCY, scanFile)
  return metas.filter((meta): meta is SessionMeta => meta !== null)
}

function projectGroup(cwd: string, sessions: SessionMeta[]): ProjectGroup {
  const resolved = cwd === '(unknown)' ? cwd : resolve(cwd)
  return {
    cwd: resolved,
    name: resolved === '(unknown)' ? '未知项目' : basename(resolved) || resolved,
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

export async function listOpenedProjects(cwds: string[]): Promise<ProjectGroup[]> {
  return Promise.all(cwds.map(async (cwd) => (await listProject(cwd)) ?? projectGroup(cwd, [])))
}

export async function listProjects(): Promise<ProjectGroup[]> {
  const metas = await scanFiles(await collectAllFiles())
  const byCwd = new Map<string, SessionMeta[]>()
  for (const meta of metas) {
    const cwd = meta.cwd || '(unknown)'
    const arr = byCwd.get(cwd)
    if (arr) arr.push(meta)
    else byCwd.set(cwd, [meta])
  }

  const groups = [...byCwd].map(([cwd, sessions]) => projectGroup(cwd, sessions))
  groups.sort((a, b) => (b.sessions[0]?.modified ?? '').localeCompare(a.sessions[0]?.modified ?? ''))
  return groups
}

export async function listProjectFiles(cwd: string): Promise<string[]> {
  if (cwd === '(unknown)') {
    return (await scanFiles(await collectAllFiles())).filter((meta) => !meta.cwd).map((meta) => meta.path)
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
  const sessions = await scanFiles(await listJsonlFiles(dir))
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
