import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

async function runFixture(scenario: string): Promise<void> {
  const realFs = { ...fs }
  const root = await realFs.mkdtemp(join(tmpdir(), 'pig-counting-'))
  let fault: { operation: 'lstat' | 'open' | 'resolve'; code: string } | undefined
  const fail = (operation: string): void => {
    if (fault?.operation === operation) throw Object.assign(new Error(`injected ${fault.code}`), { code: fault.code })
  }
  const { resolveWorktreePath } = await import('../src/main/files/paths')
  mock.module('../src/main/files/paths', () => ({
    resolveWorktreePath: async (...args: Parameters<typeof resolveWorktreePath>) => {
      fail('resolve')
      return resolveWorktreePath(...args)
    }
  }))
  mock.module('node:fs/promises', () => ({
    ...realFs,
    lstat: async (path: string) => { fail('lstat'); return realFs.lstat(path) },
    open: async (...args: Parameters<typeof realFs.open>) => { fail('open'); return realFs.open(...args) }
  }))
  mock.module('../src/main/git/run', () => ({
    runGit: async (_cwd: string, args: string[]) => {
      if (args.includes('--is-inside-work-tree')) return 'true\n'
      if (args.includes('--verify')) return 'HEAD\n'
      if (args[0] === 'status') return '?? count.txt\0'
      return ''
    }
  }))
  const { countUntrackedFiles, readWorktreeDiff } = await import('../src/main/git/diff')
  try {
    if (scenario === 'queues') {
      const roots = [join(root, 'first'), join(root, 'second')]
      for (const cwd of roots) {
        await realFs.mkdir(cwd)
        await realFs.writeFile(join(cwd, 'count.txt'), 'one\ntwo\n')
        await countUntrackedFiles(cwd, ['count.txt'])
      }
      const { backgroundCountLanes } = await import('../src/main/git/limit')
      let release = (): void => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      const backlog = Array.from({ length: 1000 }, () => backgroundCountLanes.run(() => gate))
      // A real count request also queues behind this backlog, while both cached lists must remain usable.
      const queuedCount = countUntrackedFiles(roots[0]!, ['count.txt'])
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          Promise.all(roots.map((cwd) => readWorktreeDiff(cwd))),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('list refresh waited for background counts')), 2000)
          })
        ])
        assert.deepEqual(result.map((diff) => diff.all[0]?.additions), [2, 2])
      } finally {
        clearTimeout(timer)
        release()
        await Promise.all([...backlog, queuedCount])
      }
    } else {
      const path = join(root, 'count.txt')
      await realFs.writeFile(path, 'one\n')
      for (const operation of ['lstat', 'open', 'resolve'] as const) {
        for (const code of ['EIO', 'EMFILE']) {
          fault = { operation, code }
          await assert.rejects(countUntrackedFiles(root, ['count.txt']), { code })
        }
      }
      for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
        fault = { operation: 'lstat', code }
        assert.deepEqual(await countUntrackedFiles(root, ['count.txt']), { 'count.txt': null })
      }
      fault = undefined
      assert.deepEqual(await countUntrackedFiles(root, ['count.txt']), { 'count.txt': 1 })
      for (const operation of ['lstat', 'resolve'] as const) {
        for (const code of ['EIO', 'EMFILE']) {
          fault = { operation, code }
          await assert.rejects(readWorktreeDiff(root), { code })
        }
      }
      for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
        fault = { operation: 'lstat', code }
        const diff = await readWorktreeDiff(root)
        assert.equal(diff.all[0]?.additions, null)
        fault = undefined
        await countUntrackedFiles(root, ['count.txt'])
      }
    }
  } finally {
    await realFs.rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--counting-fixture') {
  await runFixture(process.argv[3]!)
} else {
  for (const [scenario, title] of [
    ['queues', 'background read backlog does not block cached list refreshes across workspaces'],
    ['errors', 'unexpected count and validation errors propagate; only missing and permission errors recover']
  ]) {
    test(title!, async () => {
      const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--counting-fixture', scenario!], {
        timeoutMs: 10_000
      })
      assert.equal(exitCode, 0, stderr || stdout)
    })
  }
}
