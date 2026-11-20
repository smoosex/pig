import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  buildBotWorktreeBranch,
  formatBotShortId,
  formatBotWorktreeSlug,
  git,
  validateBotBranchName,
  validateBranchName,
  WorktreeService
} from '../src/main/worktrees'
import { applyLocaleSetting } from '../src/main/i18n'

applyLocaleSetting('zh-CN')

const temps: string[] = []
const services: WorktreeService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-bot-worktree-')))
  temps.push(root)
  const project = join(root, 'demo-app')
  await mkdir(project)
  await git(project, ['init', '-b', 'main'])
  await writeFile(join(project, 'README.md'), 'hello\n')
  await git(project, ['add', 'README.md'])
  const tree = (await git(project, ['write-tree'])).trim()
  const commit = (await git(project, ['-c', 'user.name=Pig Test', '-c', 'user.email=test@localhost', 'commit-tree', tree, '-m', 'init'])).trim()
  await git(project, ['update-ref', 'HEAD', commit])
  const storage = join(root, 'worktrees')
  const service = new WorktreeService(storage)
  services.push(service)
  return { root, project, storage, service }
}

describe('bot worktree naming and ownership', () => {
  test('normalizes slugs, truncates long inputs, falls back to task, and keeps manual validator strict', () => {
    expect(formatBotWorktreeSlug('Fix Export Speed!!')).toBe('fix-export-speed')
    expect(formatBotWorktreeSlug('修复导出性能')).toBe('task')
    expect(formatBotWorktreeSlug('   ---   ')).toBe('task')
    expect(formatBotWorktreeSlug('a'.repeat(50)).length).toBe(32)
    expect(formatBotShortId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('a1b2c3')

    const branch = buildBotWorktreeBranch('Fix Export Speed', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(branch).toBe('bot/fix-export-speed-a1b2c3')
    expect(validateBotBranchName(branch)).toBe(branch)
    // Existing manual validator must keep rejecting bot/ prefix.
    expect(() => validateBranchName(branch)).toThrow()
  })

  test('creates bot worktree with bot/<slug>-<shortId> branch, bot-<shortId> dir, owner metadata, and no pending naming', async () => {
    const { project, storage, service } = await fixture()
    const taskId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const created = await service.create(project, {
      owner: { kind: 'bot', taskId },
      slug: 'Fix Export Speed'
    })

    expect(created.branch).toBe('bot/fix-export-speed-a1b2c3')
    expect(basename(created.cwd)).toBe('bot-a1b2c3')
    expect(created.managed).toBe(true)
    expect(created.naming).toBeUndefined()
    expect(created.owner).toEqual({ kind: 'bot', taskId })

    const discovered = await service.discover(project)
    const found = discovered.find((w) => w.cwd === created.cwd)
    expect(found).toMatchObject({
      cwd: created.cwd,
      branch: 'bot/fix-export-speed-a1b2c3',
      managed: true,
      owner: { kind: 'bot', taskId }
    })
    expect(found?.naming).toBeUndefined()

    // State file stores owner and omits naming.
    const state = JSON.parse(await readFile(join(storage, '.state.json'), 'utf8'))
    expect(state.worktrees).toHaveLength(1)
    expect(state.worktrees[0].owner).toEqual({ kind: 'bot', taskId })
    expect(state.worktrees[0].naming).toBeUndefined()
  })

  test('disambiguates branch and directory collisions cleanly', async () => {
    const { project, service } = await fixture()
    const taskId = 'deadbeef-1111-2222-3333-444455556666'
    await git(project, ['branch', 'bot/fix-deadbe'])

    const first = await service.create(project, { owner: { kind: 'bot', taskId }, slug: 'fix' })
    expect(first.branch).toBe('bot/fix-deadbe-2')
    expect(basename(first.cwd)).toBe('bot-deadbe')

    const second = await service.create(project, { owner: { kind: 'bot', taskId }, slug: 'fix' })
    expect(second.branch).toBe('bot/fix-deadbe-3')
    expect(basename(second.cwd)).toBe('bot-deadbe-2')
  })

  test('skips nameOnFirstPrompt and rejects retryNaming for bot-owned worktrees', async () => {
    const { project, service } = await fixture()
    const created = await service.create(project, {
      owner: { kind: 'bot', taskId: '12345678-0000-0000-0000-000000000000' },
      slug: 'audit-logs'
    })

    let called = 0
    await service.nameOnFirstPrompt(created.cwd, 'Rename me please', async () => {
      called++
      return 'feat/should-not-happen'
    })
    expect(called).toBe(0)
    const branch = (await git(created.cwd, ['symbolic-ref', '--short', 'HEAD'])).trim()
    expect(branch).toBe('bot/audit-logs-123456')

    await expect(service.retryNaming(created.cwd, async () => 'task', async () => 'feat/no')).rejects.toThrow()
  })

  test('preserves backward compatibility with legacy .state.json records without owner and supports deletion', async () => {
    const { project, service } = await fixture()
    const manual = await service.create(project)
    const botTree = await service.create(project, {
      owner: { kind: 'bot', taskId: 'abcdef01-0000-0000-0000-000000000000' },
      slug: 'cleanup-check'
    })

    const items = await service.discover(project)
    const manualItem = items.find((w) => w.cwd === manual.cwd)
    const botItem = items.find((w) => w.cwd === botTree.cwd)
    expect(manualItem?.owner).toBeUndefined()
    expect(manualItem?.naming).toBe('pending')
    expect(botItem?.owner).toEqual({ kind: 'bot', taskId: 'abcdef01-0000-0000-0000-000000000000' })

    await service.remove(project, botTree.cwd, async () => {}, async () => {})
    const afterRemove = await service.discover(project)
    expect(afterRemove.some((w) => w.cwd === botTree.cwd)).toBe(false)
  })
})
