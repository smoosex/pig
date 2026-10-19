import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { browseProjectDirectories, resolveProjectDirectory, searchProjectDirectories } from '../src/main/project-directory-browser'

const temporaryPaths: string[] = []
async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pig-directory-browser-'))
  temporaryPaths.push(path)
  return realpath(path)
}
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('lists sorted directories, hidden entries, directory links and Git markers without recursion', async () => {
  const path = await fixture()
  await Promise.all(['zeta', 'alpha', '.hidden'].map((name) => mkdir(join(path, name))))
  await mkdir(join(path, 'alpha', '.git'))
  await writeFile(join(path, 'zeta', '.git'), 'gitdir: /elsewhere')
  await writeFile(join(path, 'file'), 'not a directory')
  await symlink(join(path, 'alpha'), join(path, 'linked'))
  await symlink(join(path, 'missing'), join(path, 'broken'))
  await symlink(join(path, 'file'), join(path, 'file-link'))
  const listing = await browseProjectDirectories(path)
  expect(listing.directories).toEqual([
    { name: 'alpha', path: join(path, 'alpha'), git: true },
    { name: 'linked', path: join(path, 'linked'), git: true },
    { name: 'zeta', path: join(path, 'zeta'), git: true }
  ])
  expect(listing.truncated).toBe(false)
  expect((await browseProjectDirectories(path, true)).directories.map((item) => item.name)).toEqual([
    '.hidden', 'alpha', 'linked', 'zeta'
  ])
  expect(listing.path).toBe(path)
  expect(listing.home).toBe(homedir())
  expect(listing.parent).toBe(dirname(path))
  expect(listing.breadcrumbs[0]).toEqual({ name: parse(path).root, path: parse(path).root })
  expect(listing.breadcrumbs.at(-1)?.path).toBe(path)
  for (const crumb of listing.breadcrumbs) expect(await resolveProjectDirectory(crumb.path)).toBe(crumb.path)
})

test('cyclic child links do not hide readable siblings, but browsing a cycle directly still fails', async () => {
  const path = await fixture()
  await mkdir(join(path, 'project'))
  await symlink('self', join(path, 'self'))
  await symlink('cycle-b', join(path, 'cycle-a'))
  await symlink('cycle-a', join(path, 'cycle-b'))

  const listing = await browseProjectDirectories(path)
  expect(listing.directories).toEqual([{ name: 'project', path: join(path, 'project'), git: false }])
  expect(listing.truncated).toBe(false)
  await expect(browseProjectDirectories(join(path, 'self'))).rejects.toMatchObject({ code: 'ELOOP' })
})

test('defaults to home, expands tilde and resolves real paths with root navigation', async () => {
  const home = await realpath(homedir())
  expect(await resolveProjectDirectory('~')).toBe(home)
  expect(await resolveProjectDirectory('~/')).toBe(home)
  expect((await browseProjectDirectories()).path).toBe(home)
  const path = await fixture()
  await mkdir(join(path, 'target'))
  await symlink(join(path, 'target'), join(path, 'alias'))
  expect((await browseProjectDirectories(join(path, 'alias'))).path).toBe(join(path, 'target'))
  const root = parse(path).root
  const listing = await browseProjectDirectories(root)
  expect(listing.parent).toBeNull()
  expect(listing.breadcrumbs).toEqual([{ name: root, path: root }])
})

test('rejects relative, empty, missing and non-directory paths', async () => {
  const path = await fixture()
  await writeFile(join(path, 'file'), '')
  for (const invalid of ['', '.', 'relative/path', '~someone', join(path, 'missing'), join(path, 'file')]) {
    await expect(browseProjectDirectories(invalid)).rejects.toThrow()
  }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a denied child is explicit without blocking siblings, while entering it still fails', async () => {
  const path = await fixture()
  const denied = join(path, 'denied')
  await mkdir(denied)
  await mkdir(join(path, 'readable'))
  await chmod(denied, 0)
  try {
    const listing = await browseProjectDirectories(path)
    expect(listing.directories.map((item) => item.name)).toEqual(['denied', 'readable'])
    expect(listing.directories[0].git).toBeNull()
    expect(listing.directories[0].warning).toBeTruthy()
    await expect(browseProjectDirectories(denied)).rejects.toThrow()
  } finally {
    await chmod(denied, 0o700)
  }
})

test('returns at most 500 sorted directories and explicitly reports truncation', async () => {
  const path = await fixture()
  for (let offset = 0; offset < 500; offset += 25) {
    await Promise.all(Array.from({ length: 25 }, (_, index) => mkdir(join(path, `dir-${String(offset + index).padStart(3, '0')}`))))
  }
  expect((await browseProjectDirectories(path)).truncated).toBe(false)
  await mkdir(join(path, 'dir-500'))
  const listing = await browseProjectDirectories(path)
  expect(listing.directories).toHaveLength(500)
  expect(listing.truncated).toBe(true)
  expect(listing.directories[0]?.name).toBe('dir-000')
  expect(listing.directories.at(-1)?.name).toBe('dir-499')
})

test('searches nested folder names breadth-first without entering repositories, dependencies or links', async () => {
  const path = await fixture()
  for (const dir of ['apps/web-app', 'apps/api', 'work/clients/acme-web', 'repo/.git', 'repo/packages/web-inside', 'node_modules/web-dep', '.cache/web-hidden', 'web']) {
    await mkdir(join(path, dir), { recursive: true })
  }
  await symlink(join(path, 'apps'), join(path, 'web-link'))
  const result = await searchProjectDirectories(path, 'WEB')
  expect(result.directories.map((item) => item.relativePath)).toEqual([
    'web', join('apps', 'web-app'), join('work', 'clients', 'acme-web')
  ])
  expect(result.truncated).toBe(false)
  expect((await searchProjectDirectories(path, 'repo')).directories).toEqual([{ name: 'repo', path: join(path, 'repo'), relativePath: 'repo', git: true }])
  expect((await searchProjectDirectories(path, 'web', true)).directories.map((item) => item.relativePath)).toContain(join('.cache', 'web-hidden'))
  await expect(searchProjectDirectories(path, '  ')).rejects.toThrow()
  await expect(searchProjectDirectories(join(path, 'missing'), 'web')).rejects.toThrow()
})

test('folder search stops at 200 matches and reports truncation', async () => {
  const path = await fixture()
  for (let offset = 0; offset < 201; offset += 67) {
    await Promise.all(Array.from({ length: Math.min(67, 201 - offset) }, (_, index) => mkdir(join(path, `match-${offset + index}`))))
  }
  const result = await searchProjectDirectories(path, 'match')
  expect(result.directories).toHaveLength(200)
  expect(result.truncated).toBe(true)
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable subfolder is skipped by search', async () => {
  const path = await fixture()
  await mkdir(join(path, 'denied', 'target'), { recursive: true })
  await mkdir(join(path, 'open', 'target'), { recursive: true })
  await chmod(join(path, 'denied'), 0)
  try {
    const result = await searchProjectDirectories(path, 'e')
    const denied = result.directories.find((item) => item.name === 'denied')!
    expect(denied.git).toBeNull()
    expect(denied.warning).toBeTruthy()
    expect((await searchProjectDirectories(path, 'target')).directories.map((item) => item.relativePath)).toEqual([join('open', 'target')])
  } finally {
    await chmod(join(path, 'denied'), 0o700)
  }
})

test('an aborted search stops before its next batch of filesystem work', async () => {
  const path = await fixture()
  await mkdir(join(path, 'a', 'b'), { recursive: true })
  const controller = new AbortController()
  controller.abort()
  await expect(searchProjectDirectories(path, 'b', false, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
