/** Probe public GitHub trees without executing repository code; imports copy only bounded regular files. */
import { mkdtemp, mkdir, readdir, lstat, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep, posix } from 'node:path'
import { loadSkillsFromDir, type Skill, type ResourceDiagnostic } from '@earendil-works/pi-coding-agent'

export type SkillFetcher = (url: URL, init: RequestInit) => Promise<Response>
export const validSkillName = (name: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64
export const validRepo = (repo: string): boolean => /^[\w-]+\/[\w.-]+$/.test(repo) && !['.', '..'].includes(repo.split('/')[1])
/** Skills carry no artwork of their own; the publisher is the repository owner, as in the MCP catalog. */
export const githubAvatar = (repo: string): string => `https://github.com/${repo.split('/')[0]}.png?size=96`
const MAX_FILE = 10 * 1024 * 1024
const MAX_SKILL = 50 * 1024 * 1024
interface TreeFile { path: string; type: string; mode: string; size: number }
export interface PreparedSkills {
  root: string
  source: string
  kind: 'github' | 'local'
  repo?: string
  commit?: string
  files?: TreeFile[]
  skills: Skill[]
  diagnostics: ResourceDiagnostic[]
  cleanup: () => Promise<void>
}

/** Hash every installed file and executable bit; links and special files count as local conflicts. */
export async function skillFingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256')
  let bytes = 0
  let count = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const stat = await lstat(path)
      if (stat.isDirectory()) await walk(path)
      else if (stat.isFile()) {
        bytes += stat.size
        if (++count > 2000 || stat.size > MAX_FILE || bytes > MAX_SKILL) throw new Error('Installed skill exceeds the update size limit')
        hash.update(JSON.stringify([relative(directory, path).split(sep).join('/'), stat.mode & 0o111, stat.size]))
        hash.update(await readFile(path))
      } else throw new Error('Installed skill contains links or special files; local changes must be resolved before updating')
    }
  }
  if (!(await lstat(directory)).isDirectory()) throw new Error('Installed skill directory was replaced; update refused')
  await walk(directory)
  return hash.digest('hex')
}

export function safeSkillPath(path: string): boolean {
  return !!path && path.length <= 1024 && !/[\\\x00-\x1f:*?"<>|]/.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function githubSkillSource(input: string): { repo: string; ref: string; prefix: string } {
  if (validRepo(input)) return { repo: input, ref: 'HEAD', prefix: '' }
  const url = new URL(input.startsWith('github.com/') ? `https://${input}` : input)
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash)
    throw new Error('Use a public GitHub repository URL or an absolute local directory')
  const parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent)
  const repo = parts.slice(0, 2).join('/').replace(/\.git$/, '')
  if (!validRepo(repo)) throw new Error('Invalid GitHub repository')
  if (parts.length === 2) return { repo, ref: 'HEAD', prefix: '' }
  if (parts[2] !== 'tree' || !parts[3]) throw new Error('Use a repository or a GitHub tree URL')
  const prefix = parts.slice(4).join('/')
  if ((prefix && !safeSkillPath(prefix)) || /[\x00-\x1f]/.test(parts[3])) throw new Error('Invalid repository path')
  return { repo, ref: parts[3], prefix }
}

export async function skillResponseText(url: URL, max: number, fetcher: SkillFetcher = fetch): Promise<string> {
  if (!['https://api.github.com', 'https://raw.githubusercontent.com', 'https://www.skills.sh'].includes(url.origin))
    throw new Error('Unsupported skill source host')
  const response = await fetcher(url, {
    redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/json, text/plain;q=0.9', 'User-Agent': 'Pig-Skills' }
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${url.hostname}: HTTP ${response.status}`) }
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel()
    throw new Error('Skill source response is too large')
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > max) throw new Error('Skill source response is too large')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks).toString('utf8')
}

function rawURL(repo: string, commit: string, path: string): URL {
  return new URL(`https://raw.githubusercontent.com/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`)
}

async function eachLimit<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failed && next < items.length) {
      try { await action(items[next++]) }
      catch (error) { failed = true; throw error }
    }
  }))
  for (const result of results) if (result.status === 'rejected') throw result.reason
}

export async function prepareSkillSource(input: string, fetcher: SkillFetcher = fetch): Promise<PreparedSkills> {
  const value = input.trim()
  if (!value || value.length > 2048) throw new Error('A skill source is required')
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (isAbsolute(expanded)) {
    const root = await realpath(expanded)
    if (!(await lstat(root)).isDirectory()) throw new Error('Select a directory containing SKILL.md')
    const result = loadSkillsFromDir({ dir: root, source: 'path' })
    return { root, source: root, kind: 'local', skills: result.skills.filter((skill) => basename(skill.filePath) === 'SKILL.md'), diagnostics: result.diagnostics, cleanup: async () => {} }
  }
  const source = githubSkillSource(value)
  const commitResult = JSON.parse(await skillResponseText(new URL(`https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(source.ref)}`), 1024 * 1024, fetcher)) as { sha?: string }
  if (!commitResult.sha || !/^[a-f0-9]{40}$/.test(commitResult.sha)) throw new Error('GitHub did not return a commit')
  const commit = commitResult.sha
  const body = JSON.parse(await skillResponseText(new URL(`https://api.github.com/repos/${source.repo}/git/trees/${commit}?recursive=1`), 16 * 1024 * 1024, fetcher)) as { tree?: TreeFile[]; truncated?: boolean }
  if (body.truncated || !Array.isArray(body.tree)) throw new Error('Repository tree is incomplete; try a smaller repository')
  const files = body.tree.filter((file) => file.type === 'blob' && (!source.prefix || file.path.startsWith(`${source.prefix}/`)))
  // Only what gets written to disk must be a safe path; unrelated files in the repo may be named anything.
  const manifestFiles = files.filter((file) => posix.basename(file.path) === 'SKILL.md' && file.mode !== '120000')
  const manifests = manifestFiles.filter((file) => safeSkillPath(file.path))
  const skipped = manifestFiles.filter((file) => !safeSkillPath(file.path))
  if (manifests.length > 200) throw new Error('More than 200 skills found; use a GitHub subdirectory URL')
  const temporary = await mkdtemp(join(tmpdir(), 'pig-skills-'))
  const root = join(temporary, source.repo.split('/')[1])
  try {
    await mkdir(root)
    await eachLimit(manifests, async (file) => {
      const text = await skillResponseText(rawURL(source.repo, commit, file.path), 1024 * 1024, fetcher)
      const target = join(root, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text)
    })
    const results = manifests.map((file) => loadSkillsFromDir({ dir: dirname(join(root, file.path)), source: 'path' }))
    return {
      root, source: `https://github.com/${source.repo}${source.ref !== 'HEAD' || source.prefix ? `/tree/${encodeURIComponent(source.ref)}${source.prefix ? `/${source.prefix.split('/').map(encodeURIComponent).join('/')}` : ''}` : ''}`,
      kind: 'github', repo: source.repo, commit, files,
      skills: results.flatMap((result) => result.skills).filter((skill, index, list) => list.findIndex((other) => other.filePath === skill.filePath) === index),
      diagnostics: [
        ...skipped.map((file): ResourceDiagnostic => ({ type: 'warning', message: 'Skipped: the path is not safe to import.', path: join(root, file.path) })),
        ...results.flatMap((result) => result.diagnostics)
      ], cleanup: () => rm(temporary, { recursive: true, force: true })
    }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
}

/** Copy a prepared immutable remote revision (also used by source-level import tests). */
export async function copyPreparedSkill(prepared: PreparedSkills, skill: Skill, target: string, fetcher: SkillFetcher = fetch): Promise<void> {
  let total = 0
  let count = 0
  const put = async (path: string, bytes: Buffer, executable: boolean) => {
    total += bytes.length
    if (bytes.length > MAX_FILE || total > MAX_SKILL || ++count > 2000) throw new Error('Skill exceeds the import size limit (10 MB/file, 50 MB/skill, 2000 files)')
    const out = join(target, path)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, bytes, { flag: 'wx', mode: executable ? 0o755 : 0o644 })
  }
  if (prepared.kind === 'github') {
    const prefix = relative(prepared.root, skill.baseDir).split(sep).join('/')
    const files = prepared.files!.filter((file) => !prefix || file.path.startsWith(`${prefix}/`))
    if (files.some((file) => !['100644', '100755'].includes(file.mode))) throw new Error('Skills containing symbolic links are not supported')
    if (files.some((file) => !safeSkillPath(file.path))) throw new Error('Skill contains a file path that is not safe to import.')
    if (files.length > 2000 || files.reduce((sum, file) => sum + file.size, 0) > MAX_SKILL || files.some((file) => file.size > MAX_FILE)) throw new Error('Skill exceeds the import size limit')
    // Buffers preserve binary supporting files; the immutable commit is the one shown by the probe.
    await eachLimit(files, async (file) => {
      const url = rawURL(prepared.repo!, prepared.commit!, file.path)
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Pig-Skills' } })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub: HTTP ${response.status}`) }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Empty GitHub response')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_FILE || total + size > MAX_SKILL) throw new Error('Skill exceeds the import size limit')
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel() }
      await put(prefix ? file.path.slice(prefix.length + 1) : file.path, Buffer.concat(chunks), file.mode === '100755')
    })
  } else {
    const base = await realpath(skill.baseDir)
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        const file = join(dir, entry.name)
        const stat = await lstat(file)
        if (stat.isSymbolicLink()) throw new Error(`Symbolic links inside a skill are not supported: ${entry.name}`)
        if (stat.isDirectory()) await walk(file)
        else if (stat.isFile()) {
          if (stat.size > MAX_FILE || total + stat.size > MAX_SKILL) throw new Error('Skill exceeds the import size limit')
          await put(relative(base, file), await readFile(file), !!(stat.mode & 0o111))
        } else throw new Error(`Unsupported skill file: ${entry.name}`)
      }
    }
    await walk(base)
  }
  const copied = loadSkillsFromDir({ dir: target, source: 'path' }).skills.find((item) => basename(item.filePath) === 'SKILL.md')
  if (!copied || copied.name !== skill.name) throw new Error('Skill changed since the preview; scan the source again')
}
