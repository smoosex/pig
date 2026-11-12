import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'
import type { GitExecOptions } from '../src/main/git/exec'

async function fixture() {
  const fs = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pig-search-scan-')))
  const { mock } = await import('bun:test')
  let mode: 'limit' | 'enumeration' | 'git' = 'limit'
  let enumerated = 0, closed = 0
  let controller = new AbortController()
  const reason = new Error('cancelled test scan')
  const started = Promise.withResolvers<void>()
  const batches: { count: number; signal?: AbortSignal }[] = []
  mock.module('node:fs/promises', () => ({ ...fs,
    readdir: async () => { throw new Error('Search must not materialize the whole directory') },
    opendir: async (_path: string, options: { bufferSize: number }) => {
      assert.ok(options.bufferSize > 0 && options.bufferSize <= 32)
      return (async function* () {
        try {
          for (let index = 0; index < 1_000_000; index++) {
            enumerated++
            if (mode === 'enumeration' && index === 2) controller.abort(reason)
            yield {
              name: index === 0 ? '.git' : `file-${index}.ts`,
              isDirectory: () => index === 0,
              isFile: () => index > 1,
              isSymbolicLink: () => false
            }
          }
        } finally { closed++ }
      })()
    }
  }))
  mock.module('../src/main/git/exec', () => ({
    GitExecError: class extends Error {},
    isNotARepoError: () => false,
    execGit: async (_cwd: string, args: string[], options: GitExecOptions) => {
      batches.push({ count: args.length - 2, signal: options.signal })
      if (mode !== 'git') return ''
      started.resolve()
      return new Promise<string>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
    }
  }))
  const { readDirectory } = await import('../src/main/files/tree')
  const { searchFiles } = await import('../src/main/files/search')
  try {
    const bounded = await readDirectory(root, '', { maxEntries: 7 })
    assert.equal(enumerated, 7)
    assert.equal(closed, 1)
    assert.equal(bounded.scanned, 7, 'hidden and non-file entries count too')
    assert.equal(bounded.entries.length, 5)
    assert.equal(bounded.truncated, true)
    assert.equal(batches[0]!.count, 5)

    enumerated = closed = 0; batches.length = 0
    assert.deepEqual(await searchFiles(root, 'never-match', true), { entries: [], truncated: true })
    assert.equal(enumerated, 10000, 'the entry limit applies before materializing and classifying a million-entry level')
    assert.equal(closed, 1)
    assert.equal(batches.reduce((sum, batch) => sum + batch.count, 0), 9998)

    enumerated = closed = 0; batches.length = 0; mode = 'enumeration'
    await assert.rejects(searchFiles(root, 'never-match', true, controller.signal), error => error === reason)
    assert.equal(enumerated, 3)
    assert.equal(closed, 1, 'cancellation releases the directory iterator')
    assert.equal(batches.length, 0, 'cancelled enumeration cannot start Git')

    enumerated = closed = 0; mode = 'git'; controller = new AbortController()
    const pending = searchFiles(root, 'never-match', true, controller.signal)
    await started.promise
    controller.abort(reason)
    await assert.rejects(pending, error => error === reason)
    assert.equal(batches.length, 1, 'no later ignore batch runs after cancellation')
    assert.equal(batches[0]!.signal, controller.signal, 'the running Git process receives cancellation')
    assert.equal(closed, 1)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function nativeGitFixture() {
  const fs = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, delimiter } = await import('node:path')
  const { execGit } = await import('../src/main/git/exec')
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pig-search-git-abort-')))
  const path = process.env.PATH
  let pid: number | undefined
  try {
    const executable = join(root, 'git')
    await fs.writeFile(executable, '#!/bin/sh\nprintf "%s" $$ > "$0.pid"\nexec sleep 30\n', { mode: 0o755 })
    process.env.PATH = root + delimiter + path
    const controller = new AbortController()
    const reason = new Error('cancel active Git')
    const pending = execGit(root, ['check-ignore', '--', 'file'], { signal: controller.signal })
    for (let count = 0; count < 200 && !existsSync(executable + '.pid'); count++) await new Promise(resolve => setTimeout(resolve, 10))
    pid = Number(await fs.readFile(executable + '.pid', 'utf8'))
    controller.abort(reason)
    await assert.rejects(pending, error => error === reason)
    let exited = false
    for (let count = 0; count < 200; count++) {
      try { process.kill(pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        exited = true; break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(exited, true, 'aborting Git ends the running process, not just its caller')
  } finally {
    process.env.PATH = path
    if (pid) {
      try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--scan-fixture')) await fixture()
else if (process.argv.includes('--native-git-fixture')) await nativeGitFixture()
else {
  test('file search enforces entry budgets and cancellation inside enumeration and Git batches', async () => {
    const result = await runSelf(import.meta.path, ['--scan-fixture'])
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
  })
  test.skipIf(process.platform === 'win32')('file-search cancellation kills its active Git process', async () => {
    const result = await runSelf(import.meta.path, ['--native-git-fixture'])
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
  })
}
