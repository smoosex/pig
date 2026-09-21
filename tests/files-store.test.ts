/**
 * The file store against a stubbed bridge: a draft that becomes dirty, a save that lands or reports the
 * file moved on, and what a worktree change event does to a tab that is clean versus one that is not —
 * which is the whole reason the store keeps the draft and the bytes it came from apart.
 *
 * Each case runs in its own process, like the other store fixtures: the bridge is bound once per process
 * by whichever test file imports a store first, so a stub installed here has to stay out of everyone
 * else's.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { FileReadResult, SessionApi } from '../src/shared/api'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const text = (contents: string, mtimeMs: number, size = contents.length): FileReadResult => ({
  kind: 'text',
  contents,
  mtimeMs,
  size
})

async function runFixture(name: string): Promise<void> {
  const api: Partial<SessionApi> = {}
  Object.defineProperty(globalThis, 'window', { value: { api }, configurable: true })

  if (name === 'save') {
    const written: { path: string; contents: string; overwrite?: boolean; expected?: number }[] = []
    let disk = 'one\n'
    let stamp = { mtimeMs: 1, size: 4 }
    Object.assign(api, {
      readFile: async () => text(disk, stamp.mtimeMs),
      writeFile: async (
        _cwd: string,
        path: string,
        contents: string,
        options: { expected?: { mtimeMs: number }; overwrite?: boolean }
      ) => {
        written.push({ path, contents, overwrite: options.overwrite, expected: options.expected?.mtimeMs })
        if (!options.overwrite && options.expected?.mtimeMs !== stamp.mtimeMs) return { kind: 'conflict' }
        disk = contents
        stamp = { mtimeMs: stamp.mtimeMs + 1, size: contents.length }
        return { kind: 'written', ...stamp }
      }
    } satisfies Partial<SessionApi>)
    const { fileKey, isDirty, useFilesStore } = await import('../src/renderer/src/stores/files')
    const cwd = '/store-save'
    const key = fileKey(cwd, 'src/one.ts')

    await useFilesStore.getState().openDocument(cwd, 'src/one.ts')
    const opened = useFilesStore.getState().documents[key]!
    assert.equal(opened.text, 'one\n')
    assert.equal(isDirty(opened), false, 'a freshly read file has nothing to save')
    assert.deepEqual(opened.stamp, { mtimeMs: 1, size: 4 })

    useFilesStore.getState().setDraft(cwd, 'src/one.ts', 'two\n')
    assert.equal(isDirty(useFilesStore.getState().documents[key]!), true)

    await useFilesStore.getState().saveDocument(cwd, 'src/one.ts')
    const saved = useFilesStore.getState().documents[key]!
    assert.deepEqual(written, [{ path: 'src/one.ts', contents: 'two\n', overwrite: false, expected: 1 }])
    assert.equal(saved.text, 'two\n')
    assert.equal(saved.saved, 'two\n')
    assert.equal(isDirty(saved), false)
    assert.equal(saved.stale, false)
    assert.equal(saved.stamp?.mtimeMs, 2, 'the stamp follows the write, not the read')

    // Somebody else edits the file, and this draft now describes a version that is gone.
    disk = 'theirs\n'
    stamp = { mtimeMs: 9, size: 7 }
    useFilesStore.getState().setDraft(cwd, 'src/one.ts', 'mine\n')
    await useFilesStore.getState().saveDocument(cwd, 'src/one.ts')
    const conflicted = useFilesStore.getState().documents[key]!
    assert.equal(conflicted.stale, true)
    assert.equal(conflicted.text, 'mine\n', 'a conflict keeps the draft')
    assert.equal(conflicted.saveError, undefined, 'and is not an error: it is an answer')

    await useFilesStore.getState().saveDocument(cwd, 'src/one.ts', true)
    const overwritten = useFilesStore.getState().documents[key]!
    assert.equal(written.at(-1)?.overwrite, true)
    assert.equal(overwritten.stale, false)
    assert.equal(overwritten.saved, 'mine\n')
    assert.equal(disk, 'mine\n')

    // A write that fails says so and leaves the draft where it was.
    api.writeFile = async () => {
      throw new Error("Error invoking remote method 'files:write': Error: 没有写入权限")
    }
    useFilesStore.getState().setDraft(cwd, 'src/one.ts', 'later\n')
    await useFilesStore.getState().saveDocument(cwd, 'src/one.ts')
    const failed = useFilesStore.getState().documents[key]!
    assert.equal(failed.saveError, '没有写入权限', "the failure reads in main's own words")
    assert.equal(isDirty(failed), true)
    return
  }

  if (name === 'refresh') {
    let changed: ((cwd: string) => void) | undefined
    let disk = 'first\n'
    Object.assign(api, {
      readFile: async () => text(disk, 1),
      onDiffChanged: (listener: (cwd: string) => void) => {
        changed = listener
        return () => { changed = undefined }
      }
    } satisfies Partial<SessionApi>)
    const { fileKey, isDirty, watchWorktreeFiles, useFilesStore } = await import('../src/renderer/src/stores/files')
    const cwd = '/store-refresh'
    const key = fileKey(cwd, 'src/watched.ts')
    const document = () => useFilesStore.getState().documents[key]!

    watchWorktreeFiles()
    await useFilesStore.getState().openDocument(cwd, 'src/watched.ts')
    const firstRevision = document().revision
    assert.equal(document().text, 'first\n')
    assert.equal(changed !== undefined, true, 'the store listens to the one change event main pushes')

    // The same bytes stamped again say nothing happened, so the surface is not remounted for it.
    changed?.(cwd)
    await sleep(0)
    assert.equal(document().revision, firstRevision, 'bytes that match keep the revision')
    assert.equal(document().stale, false)

    // An agent writing the file while nobody is editing it is simply adopted.
    disk = 'second\n'
    changed?.(cwd)
    await sleep(0)
    assert.equal(document().text, 'second\n')
    assert.equal(document().revision, firstRevision + 1, 'adopted bytes are a new revision of the surface')
    assert.equal(isDirty(document()), false)

    // With a draft in flight the reader keeps what they typed, and is told the file moved on.
    disk = 'third\n'
    useFilesStore.getState().setDraft(cwd, 'src/watched.ts', 'mine\n')
    changed?.(cwd)
    await sleep(0)
    assert.equal(document().text, 'mine\n', 'the draft is never replaced behind the reader')
    assert.equal(document().saved, 'second\n')
    assert.equal(document().stale, true)

    // Reloading is the reader's own answer to that, and it drops the draft for what is on disk.
    await useFilesStore.getState().reloadDocument(cwd, 'src/watched.ts')
    assert.equal(document().text, 'third\n')
    assert.equal(document().saved, 'third\n')
    assert.equal(document().stale, false)
    assert.equal(isDirty(document()), false)

    // A refresh that cannot read says so rather than passing for a quiet worktree: main names only the
    // worktree, so a failed read is no evidence that this file changed.
    api.readFile = async () => {
      throw new Error("Error invoking remote method 'files:read': Error: EACCES: permission denied")
    }
    changed?.(cwd)
    await sleep(0)
    assert.equal(document().text, 'third\n', 'the reader keeps what the last read brought in')
    assert.equal(document().refreshError, 'EACCES: permission denied', "the failure reads in main's words")
    assert.equal(document().stale, false, 'a read that failed is not a change to this document')

    // The same goes for a draft: nothing has been seen that contradicts it, so it is not called stale.
    useFilesStore.getState().setDraft(cwd, 'src/watched.ts', 'mine\n')
    changed?.(cwd)
    await sleep(0)
    assert.equal(document().text, 'mine\n', 'the draft is never replaced behind the reader')
    assert.equal(document().stale, false)
    assert.equal(document().refreshError, 'EACCES: permission denied')

    // The read that lands next clears the failure, whichever branch of the draft it takes.
    disk = 'third\n'
    api.readFile = async () => text(disk, 3)
    changed?.(cwd)
    await sleep(0)
    assert.equal(document().refreshError, undefined)
    assert.equal(isDirty(document()), true, 'a draft the file agrees with is still a draft to write')
    assert.equal(document().stale, false)
    await useFilesStore.getState().reloadDocument(cwd, 'src/watched.ts')

    // A read that a newer one has already moved past has nothing to say, including that it failed.
    let failSlowly: (() => void) | undefined
    api.readFile = async () => {
      await new Promise<void>((resolve) => {
        failSlowly = resolve
      })
      throw new Error("Error invoking remote method 'files:read': Error: EACCES: permission denied")
    }
    changed?.(cwd)
    await sleep(0)
    disk = 'fifth\n'
    api.readFile = async () => text(disk, 5)
    await useFilesStore.getState().reloadDocument(cwd, 'src/watched.ts')
    failSlowly?.()
    await sleep(0)
    assert.equal(document().refreshError, undefined, 'the reload the reader asked for is the answer that stands')
    assert.equal(document().text, 'fifth\n')
    return
  }

  if (name === 'refusals') {
    const reads: Record<string, FileReadResult> = {
      'blob.bin': { kind: 'binary', size: 8 },
      'big.txt': { kind: 'too-large', size: 3_000_000 },
      'link.txt': { kind: 'link' },
      'gone.txt': { kind: 'missing' }
    }
    Object.assign(api, { readFile: async (_cwd: string, path: string) => reads[path]! } satisfies Partial<SessionApi>)
    const { fileKey, useFilesStore } = await import('../src/renderer/src/stores/files')
    const cwd = '/store-refusals'
    for (const [path, expected] of Object.entries(reads)) {
      await useFilesStore.getState().openDocument(cwd, path)
      const document = useFilesStore.getState().documents[fileKey(cwd, path)]!
      assert.equal(document.status, 'ready')
      assert.equal(document.preview, expected.kind)
      assert.equal(document.text, '')
      assert.equal(document.saved, '')
    }

    // A read that failed rather than refused says what happened.
    api.readFile = async () => {
      throw new Error("Error invoking remote method 'files:read': Error: EACCES: permission denied")
    }
    await useFilesStore.getState().openDocument(cwd, 'locked.txt')
    const failed = useFilesStore.getState().documents[fileKey(cwd, 'locked.txt')]!
    assert.equal(failed.status, 'error')
    assert.equal(failed.error, 'EACCES: permission denied')
    return
  }

  if (name === 'tree') {
    let listings = 0
    let failure: Error | null = null
    Object.assign(api, {
      readDirectory: async (_cwd: string, path: string) => {
        listings += 1
        if (failure) throw failure
        return { path, entries: [{ name: 'one.ts', path: 'src/one.ts', kind: 'file', ignored: false }] }
      }
    } satisfies Partial<SessionApi>)
    const { useFilesStore } = await import('../src/renderer/src/stores/files')
    const cwd = '/store-tree'
    const level = () => useFilesStore.getState().trees[cwd]?.['src']

    await useFilesStore.getState().loadDirectory(cwd, 'src')
    assert.equal(level()?.status, 'ready')
    assert.equal(listings, 1)

    await useFilesStore.getState().loadDirectory(cwd, 'src')
    assert.equal(listings, 2, 'a refresh reads again')
    assert.equal(level()?.entries?.length, 1, 'and keeps its rows while it does')

    failure = new Error("Error invoking remote method 'files:read-directory': Error: ENOENT")
    await useFilesStore.getState().loadDirectory(cwd, 'src')
    assert.equal(level()?.status, 'error')
    assert.equal(level()?.error, 'ENOENT')

    // Opening a directory is what reads it; closing one is only a change of what is on screen.
    failure = null
    useFilesStore.getState().toggleDirectory(cwd, 'src')
    assert.equal(useFilesStore.getState().expanded[cwd]?.src, true)
    await sleep(0)
    assert.equal(listings, 4)
    useFilesStore.getState().toggleDirectory(cwd, 'src')
    assert.equal(useFilesStore.getState().expanded[cwd]?.src, false)
    assert.equal(listings, 4, 'closing it reads nothing')
    return
  }

  if (name === 'release') {
    Object.assign(api, { readFile: async () => text('clean\n', 1) } satisfies Partial<SessionApi>)
    const { fileKey, useFilesStore } = await import('../src/renderer/src/stores/files')
    const cwd = '/store-release'
    const clean = fileKey(cwd, 'clean.ts')
    const draft = fileKey(cwd, 'draft.ts')

    await useFilesStore.getState().openDocument(cwd, 'clean.ts')
    await useFilesStore.getState().openDocument(cwd, 'draft.ts')
    useFilesStore.getState().setDraft(cwd, 'draft.ts', 'unsaved\n')

    useFilesStore.getState().releaseDocument(cwd, 'clean.ts')
    useFilesStore.getState().releaseDocument(cwd, 'draft.ts')
    assert.equal(useFilesStore.getState().documents[clean], undefined)
    assert.equal(useFilesStore.getState().documents[draft]?.text, 'unsaved\n', 'the draft outlives its tab')

    // Reopening the file the draft belongs to finds the draft rather than reading over it.
    await useFilesStore.getState().openDocument(cwd, 'draft.ts')
    assert.equal(useFilesStore.getState().documents[draft]?.text, 'unsaved\n')
    return
  }

  throw new Error(`Unknown fixture: ${name}`)
}

if (process.argv[2] === '--files-store-fixture') {
  await runFixture(process.argv[3])
} else {
  for (const [name, description] of Object.entries({
    save: 'a draft is dirty until it is saved, and a file that moved on answers conflict',
    refresh: 'a change event adopts new bytes when the tab is clean and flags them when it is not',
    refusals: 'a file that cannot be edited says which kind it is, and keeps no draft',
    tree: 'a directory level is read once, kept while it refreshes, and reports a listing that failed',
    release: 'closing a tab keeps a draft and lets a clean document go'
  })) {
    test(`files store: ${description}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--files-store-fixture', name], {
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}
