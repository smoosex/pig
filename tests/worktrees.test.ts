import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { GitExecError, isNotARepoError } from '../src/main/git/exec'
import { canonicalProject, git, isGitProject, parseWorktrees, validateBranchName, WorktreeService } from '../src/main/worktrees'
import { applyLocaleSetting } from '../src/main/i18n'

// Pig's own errors come from the dictionary: pin the wording these tests spell out.
applyLocaleSetting('zh-CN')


const temps: string[] = []
const services: WorktreeService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-worktree-test-')))
  temps.push(root)
  const project = join(root, 'project with spaces')
  await mkdir(project)
  await git(project, ['init', '-b', 'main'])
  if (committed) {
    await writeFile(join(project, 'tracked.txt'), 'initial\n')
    await git(project, ['add', 'tracked.txt'])
    const tree = (await git(project, ['write-tree'])).trim()
    const commit = (await git(project, ['-c', 'user.name=Pig Test', '-c', 'user.email=test@localhost', 'commit-tree', tree, '-m', 'fixture'])).trim()
    await git(project, ['update-ref', 'HEAD', commit])
  }
  const storage = join(root, 'worktrees')
  const service = new WorktreeService(storage)
  services.push(service)
  return { root, project, storage, service }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const noop = async () => {}

describe('worktree discovery and lifecycle', () => {
  test('only classifies a completed Git not-a-repository failure as a plain directory', () => {
    const failure = (code: string | number | null, stderr: string, killed = false) =>
      new GitExecError(stderr, { name: 'Error', message: stderr, code, stderr, killed })
    expect(isNotARepoError(failure(128, 'fatal: not a git repository'))).toBe(true)
    expect(isNotARepoError(failure(128, 'fatal: detected dubious ownership'))).toBe(false)
    expect(isNotARepoError(failure('ENOENT', 'not a git repository'))).toBe(false)
    expect(isNotARepoError(failure(null, 'not a git repository', true))).toBe(false)
  })

  test('parses nul-delimited paths, branches, detached and locked worktrees', () => {
    const entries = parseWorktrees('worktree /repo\0HEAD aabbccdd1234\0branch refs/heads/main\0\0worktree /tree with\nnewline\0HEAD 112233445566\0detached\0locked reason\0prunable gone\0\0')
    expect(entries[0]).toMatchObject({ branch: 'main', isPrimary: true })
    expect(entries[1]).toMatchObject({ cwd: '/tree with\nnewline', branch: 'detached/11223344', locked: true, missing: true })
  })

  test('non-git discovery uses project name without initializing it', async () => {
    const { root, service } = await fixture()
    const cwd = join(root, 'no-git')
    await mkdir(cwd)
    expect(await isGitProject(cwd)).toBe(false)
    expect(await service.discover(cwd)).toEqual([{ cwd, branch: 'no-git', isPrimary: true, locked: false, missing: false, managed: false }])
    await expect(service.create(cwd)).rejects.toThrow('请先初始化 Git')
  })

  test('creates a UUID directory and branch from original HEAD, leaving dirty files alone', async () => {
    const { project, service } = await fixture()
    await writeFile(join(project, 'tracked.txt'), 'uncommitted\n')
    await writeFile(join(project, 'private.txt'), 'local\n')
    const before = await git(project, ['status', '--porcelain'])
    const worktree = await service.create(project)
    expect(worktree.branch).toMatch(/^[0-9a-f-]{36}$/)
    expect(basename(worktree.cwd)).toBe(worktree.branch)
    expect(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8')).toBe('initial\n')
    expect(await stat(join(worktree.cwd, 'private.txt')).catch(() => null)).toBeNull()
    expect(await git(project, ['status', '--porcelain'])).toBe(before)
    expect(await canonicalProject(worktree.cwd)).toBe(project)
    const reopened = new WorktreeService(service.root)
    services.push(reopened)
    expect((await reopened.discover(project))[1]).toMatchObject({ cwd: worktree.cwd, naming: 'pending', managed: true })
  })

  test('accepts a symlinked project path without duplicate ownership', async () => {
    const { root, project, service } = await fixture()
    const alias = join(root, 'alias')
    await symlink(project, alias)
    const tree = await service.create(alias)
    expect(await canonicalProject(alias)).toBe(project)
    expect((await service.discover(alias))[1]).toMatchObject({ cwd: tree.cwd, managed: true })
  })

  test('discovers an existing external worktree without claiming it as managed', async () => {
    const { root, project, service } = await fixture()
    const external = join(root, 'external')
    await git(project, ['worktree', 'add', '-b', 'existing', external])
    expect((await service.discover(project))[1]).toMatchObject({ cwd: external, branch: 'existing', managed: false })
  })

  test('uses the project name as the storage directory', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    expect(basename(dirname(tree.cwd))).toBe('project-with-spaces')
  })

  test('same-named projects have distinct storage directories', async () => {
    const { root, project, service } = await fixture()
    const other = join(root, 'other', basename(project))
    await mkdir(other, { recursive: true })
    await git(other, ['init', '-b', 'main'])
    const [a, b] = await Promise.all([service.create(project), service.create(other)])
    // Git preflight can finish in either order; the first allocator owns the plain name.
    const parents = [a, b].map((tree) => basename(dirname(tree.cwd))).sort()
    expect(parents[0]).toBe('project-with-spaces')
    expect(parents[1]).toMatch(/^project-with-spaces-[0-9a-f]{8}$/)
    expect(await canonicalProject(a.cwd)).toBe(project)
    expect(await canonicalProject(b.cwd)).toBe(other)
  })

  test('empty repository supports an orphan worktree without making a commit', async () => {
    const { project, service } = await fixture(false)
    const tree = await service.create(project)
    await service.nameOnFirstPrompt(tree.cwd, 'Write documentation', async () => 'docs/initial-guide')
    expect((await service.discover(project))[1].branch).toBe('docs/initial-guide')
    await expect(git(project, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow()
    await service.remove(project, tree.cwd, false, noop, noop)
    expect((await service.discover(project)).length).toBe(1)
  })
})

describe('first prompt naming', () => {
  test('only one naming task runs; branch changes but directory stays fixed', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    const started = deferred<void>()
    const answer = deferred<string>()
    let calls = 0
    const done = service.nameOnFirstPrompt(tree.cwd, 'Add search', async (text) => {
      calls++
      expect(text).toBe('Add search')
      started.resolve()
      return answer.promise
    })
    await started.promise
    expect((await service.discover(project))[1].naming).toBe('naming')
    await service.nameOnFirstPrompt(tree.cwd, 'Second prompt', async () => { calls++; return 'fix/wrong-name' })
    answer.resolve('feat/add-search')
    await done
    expect(calls).toBe(1)
    expect((await service.discover(project))[1]).toMatchObject({ cwd: tree.cwd, branch: 'feat/add-search' })
    expect((await service.discover(project))[1].naming).toBeUndefined()
    await service.nameOnFirstPrompt(tree.cwd, 'Third prompt', async () => { calls++; return 'docs/other' })
    expect(calls).toBe(1)
  })

  test('no naming for original project or external worktree', async () => {
    const { project, service } = await fixture()
    await service.nameOnFirstPrompt(project, 'hello', async () => { throw new Error('must not run') })
    expect((await service.discover(project))[0].branch).toBe('main')
  })

  test('collision adds UUID suffix and does not overwrite existing branch', async () => {
    const { project, service } = await fixture()
    await git(project, ['branch', 'feat/add-search'])
    const tree = await service.create(project)
    await service.nameOnFirstPrompt(tree.cwd, 'search', async () => 'feat/add-search')
    expect((await service.discover(project))[1].branch).toBe(`feat/add-search-${tree.branch.slice(0, 8)}`)
    expect((await git(project, ['branch', '--list', 'feat/add-search'])).trim()).toBe('feat/add-search')
  })

  test('rejects unsafe output and retains visible failure across reload', async () => {
    const { project, storage, service } = await fixture()
    const tree = await service.create(project)
    await service.nameOnFirstPrompt(tree.cwd, 'task', async () => 'feat/bad; rm -rf /')
    const reload = new WorktreeService(storage)
    services.push(reload)
    expect((await reload.discover(project))[1]).toMatchObject({ branch: tree.branch, naming: 'failed' })
    expect((await reload.discover(project))[1].namingError).toContain('有效')
  })

  test('retry names a failed worktree again and a named one refuses', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await service.nameOnFirstPrompt(tree.cwd, 'task', async () => 'not-a-branch')
    expect((await service.discover(project))[1].naming).toBe('failed')
    const started = deferred<void>()
    const answer = deferred<string>()
    const { attempt } = await service.retryNaming(tree.cwd, async () => 'Add search again', async (text) => {
      expect(text).toBe('Add search again')
      started.resolve()
      return answer.promise
    })
    await started.promise
    // The record goes back into the queue as soon as the attempt is accepted, before any answer.
    expect((await service.discover(project))[1].naming).toBe('naming')
    answer.resolve('feat/add-search')
    await attempt
    const named = (await service.discover(project))[1]
    expect(named.branch).toBe('feat/add-search')
    expect(named.naming).toBeUndefined()
    expect(named.namingError).toBeUndefined()
    await expect(service.retryNaming(tree.cwd, async () => 'x', async () => 'docs/later')).rejects.toThrow('已经命名过')
  })

  test('a retry that fails again keeps the failure and the UUID branch', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await service.nameOnFirstPrompt(tree.cwd, 'task', async () => 'still-wrong')
    await (await service.retryNaming(tree.cwd, async () => 'task', async () => 'also-wrong')).attempt
    expect((await service.discover(project))[1]).toMatchObject({ branch: tree.branch, naming: 'failed' })
  })

  test('overlapping retries share preparation and remain retryable after cancellation and restart', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await service.nameOnFirstPrompt(tree.cwd, 'original task', async () => 'invalid')
    const reading = deferred<void>()
    const history = deferred<string>()
    const started = deferred<void>()
    let reads = 0
    let calls = 0
    const task = async () => {
      reads++
      reading.resolve()
      return history.promise
    }
    const generate = async (_text: string, signal: AbortSignal) => {
      calls++
      started.resolve()
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const first = service.retryNaming(tree.cwd, task, generate)
    await reading.promise
    const second = service.retryNaming(tree.cwd, task, generate)
    history.resolve('original task')
    const [a, b] = await Promise.all([first, second])
    await started.promise
    expect(reads).toBe(1)
    expect(calls).toBe(1)
    expect(b.attempt).toBe(a.attempt)
    const live = await service.retryNaming(tree.cwd, async () => { throw new Error('must not read') }, generate)
    expect(live.attempt).toBe(a.attempt)
    expect((await service.discover(project))[1].naming).toBe('naming')
    await service.withBlockedCwds([tree.cwd], () => a.attempt)
    await service.shutdown()
    const restarted = new WorktreeService(service.root)
    services.push(restarted)
    expect((await restarted.discover(project))[1].naming).toBe('failed')
    await (await restarted.retryNaming(tree.cwd, async () => 'original task', async () => 'feat/recovered')).attempt
    expect((await restarted.discover(project))[1].branch).toBe('feat/recovered')
  })

  test('a worktree that cannot be retried refuses without starting a job', async () => {
    const { project, service } = await fixture()
    await expect(service.retryNaming(join(project, 'missing'), async () => 'x', async () => 'docs/x')).rejects.toThrow('不属于已打开项目')
    const tree = await service.create(project)
    // Still waiting for its first prompt: nothing has been lost, so there is nothing to retry.
    await expect(service.retryNaming(tree.cwd, async () => 'x', async () => 'docs/x')).rejects.toThrow('已经命名过')
    await expect(service.retryNaming(tree.cwd, async () => { throw new Error('never read') }, async () => 'docs/x')).rejects.toThrow()
    // A refused attempt changes nothing, and the task is never read.
    expect((await service.discover(project))[1].naming).toBe('pending')
  })

  test('does not rename a user-switched branch', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await git(tree.cwd, ['branch', '-m', 'manual-name'])
    let calls = 0
    await service.nameOnFirstPrompt(tree.cwd, 'task', async () => { calls++; return 'feat/ignore' })
    expect(calls).toBe(0)
    expect((await service.discover(project))[1].branch).toBe('manual-name')
  })

  test('validates conventional prefixes and short kebab-case slug', () => {
    for (const name of ['feat/new-ui', 'fix/login-regression', 'docs/readme', 'ci/test-build', 'build/deps']) expect(validateBranchName(name)).toBe(name)
    for (const name of ['main', '-D', 'fix/MixedCase', 'feat/a/b', 'feat/a--b', 'feat/' + 'a'.repeat(80)]) expect(() => validateBranchName(name)).toThrow()
  })
})

describe('deletion protection and cleanup', () => {
  test('blocks original/unknown paths and preserves other worktrees', async () => {
    const { root, project, service } = await fixture()
    const tree = await service.create(project)
    const other = await service.create(project)
    await expect(service.remove(project, project, true, noop, noop)).rejects.toThrow('不能删除')
    await expect(service.remove(project, root, true, noop, noop)).rejects.toThrow('不能删除')
    const sessionDir = join(root, 'sessions')
    await mkdir(sessionDir)
    await writeFile(join(sessionDir, 'session.jsonl'), 'fixture')
    let closed = false
    await service.remove(project, tree.cwd, false, async () => {
      closed = true
      expect(() => service.assertAvailable(tree.cwd)).toThrow()
    }, async () => {
      expect(closed).toBe(true)
      await rm(sessionDir, { recursive: true })
    })
    expect(await stat(tree.cwd).catch(() => null)).toBeNull()
    expect(await stat(sessionDir).catch(() => null)).toBeNull()
    expect(await git(project, ['branch', '--list', tree.branch])).toBe('')
    expect((await service.discover(project)).map((w) => w.cwd)).toEqual([project, other.cwd])
  })

  test('dirty and ignored files require explicit force; cancelled removal changes nothing', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await writeFile(join(tree.cwd, 'new.txt'), 'important')
    expect((await service.deletionInfo(project, tree.cwd)).dirty).toBe(true)
    await expect(service.remove(project, tree.cwd, false, noop, noop)).rejects.toThrow('未提交')
    expect(await readFile(join(tree.cwd, 'new.txt'), 'utf8')).toBe('important')
    await service.remove(project, tree.cwd, true, noop, noop)
    expect((await service.discover(project)).length).toBe(1)
  })

  test('rechecks files after agents stop instead of silently deleting fresh writes', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await expect(service.remove(project, tree.cwd, false, async () => {
      await writeFile(join(tree.cwd, 'late.txt'), 'last write')
    }, noop)).rejects.toThrow('新修改')
    expect(await readFile(join(tree.cwd, 'late.txt'), 'utf8')).toBe('last write')
  })

  test('unmerged commits require explicit confirmation even with a clean working tree', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    const parent = (await git(tree.cwd, ['rev-parse', 'HEAD'])).trim()
    const index = (await git(tree.cwd, ['write-tree'])).trim()
    const commit = (await git(tree.cwd, ['-c', 'user.name=Pig Test', '-c', 'user.email=test@localhost', 'commit-tree', index, '-p', parent, '-m', 'unmerged fixture'])).trim()
    await git(tree.cwd, ['update-ref', 'HEAD', commit])
    expect(await service.deletionInfo(project, tree.cwd)).toMatchObject({ dirty: false, unmerged: true })
    await expect(service.remove(project, tree.cwd, false, noop, noop)).rejects.toThrow('未合并')
    await service.remove(project, tree.cwd, true, noop, noop)
    expect(await git(project, ['branch', '--list', tree.branch])).toBe('')
  })

  test('detached HEAD commits also require confirmation and survive failed-cleanup metadata', async () => {
    const { root, project, service } = await fixture()
    const cwd = join(root, 'detached')
    await git(project, ['worktree', 'add', '--detach', cwd])
    const parent = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
    const index = (await git(cwd, ['write-tree'])).trim()
    const commit = (await git(cwd, ['-c', 'user.name=Pig Test', '-c', 'user.email=test@localhost', 'commit-tree', index, '-p', parent, '-m', 'detached fixture'])).trim()
    await git(cwd, ['update-ref', 'HEAD', commit])
    expect(await service.deletionInfo(project, cwd)).toMatchObject({ dirty: false, unmerged: true, worktree: { detached: true, head: commit } })
    await expect(service.remove(project, cwd, false, noop, noop)).rejects.toThrow('未合并')
    await expect(service.remove(project, cwd, true, noop, async () => { throw new Error('cleanup failed') })).rejects.toThrow('cleanup failed')
    expect((await service.discover(project))[1]).toMatchObject({ detached: true, head: commit, missing: true })
    await service.remove(project, cwd, true, noop, noop)
  })

  test('real branches with a detached prefix are still deleted normally', async () => {
    const { root, project, service } = await fixture()
    const cwd = join(root, 'named-detached')
    await git(project, ['worktree', 'add', '-b', 'detached/legit', cwd])
    await service.remove(project, cwd, false, noop, noop)
    expect(await git(project, ['branch', '--list', 'detached/legit'])).toBe('')
  })

  test('rejects locked worktrees even with force', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await git(project, ['worktree', 'lock', tree.cwd])
    await expect(service.remove(project, tree.cwd, true, noop, noop)).rejects.toThrow('已锁定')
  })

  test('cleanup failure remains retryable after git removal', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    await expect(service.remove(project, tree.cwd, false, noop, async () => { throw new Error('disk error') })).rejects.toThrow('disk error')
    expect((await service.discover(project))[1]).toMatchObject({ cwd: tree.cwd, missing: true })
    await service.remove(project, tree.cwd, true, noop, noop)
    expect((await service.discover(project)).length).toBe(1)
  })

  test('shutdown cancels naming and rejects new work', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    const started = deferred<void>()
    const naming = service.nameOnFirstPrompt(tree.cwd, 'task', async (_text, signal) => {
      started.resolve()
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    })
    await started.promise
    await service.shutdown()
    await naming
    expect(() => service.assertAvailable(tree.cwd)).toThrow()
    await expect(service.create(project)).rejects.toThrow()
    const restarted = new WorktreeService(service.root)
    services.push(restarted)
    expect((await restarted.discover(project))[1]).toMatchObject({ branch: tree.branch, naming: 'failed' })
  })

  test('shutdown aborts active naming before waiting for retry history and leaves the retry unqueued', async () => {
    const { project, service } = await fixture()
    const active = await service.create(project)
    const retryable = await service.create(project)
    await service.nameOnFirstPrompt(retryable.cwd, 'retry task', async () => 'invalid')
    const started = deferred<AbortSignal>()
    const naming = service.nameOnFirstPrompt(active.cwd, 'active task', async (_text, signal) => {
      started.resolve(signal)
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const signal = await started.promise
    const reading = deferred<void>()
    const history = deferred<string>()
    let calls = 0
    const preparing = service.retryNaming(retryable.cwd, async () => {
      reading.resolve()
      return history.promise
    }, async () => { calls++; return 'feat/too-late' })
    await reading.promise
    const refusal = preparing.then(() => null, (error: unknown) => error)
    let finished = false
    const shutdown = service.shutdown().then(() => { finished = true })
    try {
      expect(signal.aborted).toBe(true)
      await naming
      expect(finished).toBe(false)
    } finally {
      history.resolve('retry task')
      await shutdown
    }
    expect(await refusal).toMatchObject({ message: 'Worktree 正在删除或应用正在退出' })
    expect(calls).toBe(0)
    const restarted = new WorktreeService(service.root)
    services.push(restarted)
    const item = (await restarted.discover(project)).find((tree) => tree.cwd === retryable.cwd)
    expect(item).toMatchObject({ branch: retryable.branch, naming: 'failed' })
    await (await restarted.retryNaming(retryable.cwd, async () => 'retry task', async () => 'feat/recovered')).attempt
    expect((await restarted.discover(project)).find((tree) => tree.cwd === retryable.cwd)?.branch).toBe('feat/recovered')
  })

  test('deleting during naming aborts the temporary job without recreating the branch', async () => {
    const { project, service } = await fixture()
    const tree = await service.create(project)
    const started = deferred<void>()
    const naming = service.nameOnFirstPrompt(tree.cwd, 'task', async (_text, signal) => {
      started.resolve()
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    })
    await started.promise
    await service.remove(project, tree.cwd, false, noop, noop)
    await naming
    expect((await service.discover(project)).length).toBe(1)
    expect(await git(project, ['branch', '--list', tree.branch])).toBe('')
  })
})
