/** Skill imports use immutable GitHub files and never run repository code or follow internal links. */
import { test, expect } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyPreparedSkill, githubSkillSource, prepareSkillSource, safeSkillPath, skillFingerprint, skillResponseText, type SkillFetcher } from '../src/main/skills/source'

const manifest = (name: string) => `---\nname: ${name}\ndescription: A useful workflow\n---\nRead references/guide.md.\n`
const commit = 'a'.repeat(40)

test('accepts only explicit local paths or public GitHub repository/tree addresses', () => {
  expect(githubSkillSource('owner/repo')).toEqual({ repo: 'owner/repo', ref: 'HEAD', prefix: '' })
  expect(githubSkillSource('https://github.com/owner/repo/tree/main/skills/pdf')).toEqual({ repo: 'owner/repo', ref: 'main', prefix: 'skills/pdf' })
  for (const value of ['https://evil.example/owner/repo', 'https://user:pass@github.com/owner/repo', 'http://github.com/owner/repo', 'https://github.com/owner/repo?x=y', 'https://github.com/owner/repo/tree/main/%2e%2e%2fother']) expect(() => githubSkillSource(value)).toThrow()
  for (const value of ['/absolute', '../escape', 'x/../../escape', 'x\\escape', 'a//b']) expect(safeSkillPath(value)).toBe(false)
})

test('probes and copies a local skill without changing its original files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-skill-local-'))
  try {
    const source = join(root, 'source', 'local-workflow')
    await mkdir(join(source, 'references'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), manifest('local-workflow'))
    await writeFile(join(source, 'references', 'guide.md'), 'original')
    const prepared = await prepareSkillSource(join(root, 'source'))
    expect(prepared.skills.map((skill) => skill.name)).toEqual(['local-workflow'])
    const target = join(root, 'copy', 'local-workflow')
    await copyPreparedSkill(prepared, prepared.skills[0], target)
    await writeFile(join(target, 'references', 'guide.md'), 'changed copy')
    expect(await readFile(join(source, 'references', 'guide.md'), 'utf8')).toBe('original')
    await symlink(join(root, 'source'), join(source, 'references', 'outside'))
    await expect(copyPreparedSkill(prepared, prepared.skills[0], join(root, 'another', 'local-workflow'))).rejects.toThrow(/Symbolic links/)
    await prepared.cleanup()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('GitHub preview pins the commit and imports supporting binary files', async () => {
  const requests: string[] = []
  const binary = new Uint8Array([0, 255, 128, 10])
  const fetcher: SkillFetcher = async (url, init) => {
    requests.push(url.href)
    expect(init.redirect).toBe('error')
    if (url.hostname === 'api.github.com' && url.pathname.includes('/commits/')) return Response.json({ sha: commit })
    if (url.hostname === 'api.github.com') return Response.json({ tree: [
      { path: 'skills/pdf/SKILL.md', type: 'blob', mode: '100644', size: 100 },
      { path: 'skills/pdf/assets/example.bin', type: 'blob', mode: '100644', size: 4 },
      { path: 'skills/other/SKILL.md', type: 'blob', mode: '100644', size: 100 }
    ] })
    expect(url.pathname).toContain(`/${commit}/`)
    return new Response(url.pathname.endsWith('.bin') ? binary : manifest('pdf'))
  }
  const root = await mkdtemp(join(tmpdir(), 'pig-skill-remote-'))
  const prepared = await prepareSkillSource('https://github.com/owner/repo/tree/main/skills/pdf', fetcher)
  try {
    expect(prepared.skills.map((skill) => skill.name)).toEqual(['pdf'])
    const target = join(root, 'pdf')
    await copyPreparedSkill(prepared, prepared.skills[0], target, fetcher)
    expect(new Uint8Array(await readFile(join(target, 'assets', 'example.bin')))).toEqual(binary)
    expect(requests.some((url) => url.endsWith('/skills/other/SKILL.md'))).toBe(false)
    prepared.files!.push({ path: 'skills/pdf/link', type: 'blob', mode: '120000', size: 2 })
    await expect(copyPreparedSkill(prepared, prepared.skills[0], join(root, 'unsafe', 'pdf'), fetcher)).rejects.toThrow(/symbolic links/)
  } finally { await prepared.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('tracked GitHub source URLs preserve literal percent and hash directory names', async () => {
  const prefix = 'skills/literal%20#value'
  const input = `https://github.com/owner/repo/tree/main/${prefix.split('/').map(encodeURIComponent).join('/')}`
  const fetcher: SkillFetcher = async (url) => {
    if (url.pathname.includes('/commits/')) return Response.json({ sha: commit })
    if (url.hostname === 'api.github.com') return Response.json({ tree: [
      { path: `${prefix}/SKILL.md`, type: 'blob', mode: '100644', size: 100 }
    ] })
    return new Response(manifest('literal-path'))
  }
  const prepared = await prepareSkillSource(input, fetcher)
  try {
    expect(prepared.source).toBe(input)
    expect(githubSkillSource(prepared.source).prefix).toBe(prefix)
    const next = await prepareSkillSource(prepared.source, fetcher)
    try { expect(next.skills.map((skill) => skill.name)).toEqual(['literal-path']) }
    finally { await next.cleanup() }
  } finally { await prepared.cleanup() }
})

test.skipIf(process.platform === 'win32')('installed fingerprints detect individual executable permission changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-skill-fingerprint-'))
  try {
    const path = join(root, 'script.sh')
    await writeFile(path, 'echo example\n')
    await chmod(path, 0o755)
    const before = await skillFingerprint(root)
    await chmod(path, 0o655)
    expect(await skillFingerprint(root)).not.toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects truncated GitHub trees before downloading files', async () => {
  let raw = 0
  const fetcher: SkillFetcher = async (url) => {
    if (url.hostname === 'raw.githubusercontent.com') raw++
    return Response.json(url.pathname.includes('/commits/') ? { sha: commit } : { tree: [], truncated: true })
  }
  await expect(prepareSkillSource('owner/repo', fetcher)).rejects.toThrow(/incomplete/)
  expect(raw).toBe(0)
})

test('unsafe paths only matter where files are written', async () => {
  const requests: string[] = []
  const fetcher: SkillFetcher = async (url) => {
    requests.push(url.pathname)
    if (url.pathname.includes('/commits/')) return Response.json({ sha: commit })
    if (url.hostname === 'api.github.com') return Response.json({ tree: [
      { path: 'docs/notes: draft?.md', type: 'blob', mode: '100644', size: 5 },
      { path: 'skills/good/SKILL.md', type: 'blob', mode: '100644', size: 100 },
      { path: '../escape/SKILL.md', type: 'blob', mode: '100644', size: 100 },
      { path: 'skills/bad/SKILL.md', type: 'blob', mode: '100644', size: 100 },
      { path: 'skills/bad/a:b.txt', type: 'blob', mode: '100644', size: 3 }
    ] })
    return new Response(manifest(url.pathname.includes('/bad/') ? 'bad' : 'good'))
  }
  const root = await mkdtemp(join(tmpdir(), 'pig-skill-unsafe-'))
  const prepared = await prepareSkillSource('owner/repo', fetcher)
  try {
    expect(prepared.skills.map((skill) => skill.name).sort()).toEqual(['bad', 'good'])
    expect(prepared.diagnostics.filter((item) => item.message.includes('not safe')).map((item) => item.path!.endsWith('escape/SKILL.md'))).toEqual([true])
    expect(requests.some((path) => path.includes('escape'))).toBe(false)
    const good = prepared.skills.find((skill) => skill.name === 'good')!
    await copyPreparedSkill(prepared, good, join(root, 'good'), fetcher)
    const bad = prepared.skills.find((skill) => skill.name === 'bad')!
    await expect(copyPreparedSkill(prepared, bad, join(root, 'bad'), fetcher)).rejects.toThrow(/not safe/)
  } finally { await prepared.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('bounded source reads reject oversized bodies and unapproved origins', async () => {
  await expect(skillResponseText(new URL('https://www.skills.sh/api/search'), 3, async () => new Response('1234'))).rejects.toThrow(/too large/)
  let fetched = false
  await expect(skillResponseText(new URL('http://127.0.0.1/private'), 10, async () => { fetched = true; return new Response('') })).rejects.toThrow(/host/)
  expect(fetched).toBe(false)
})
