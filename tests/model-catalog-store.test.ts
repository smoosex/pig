/**
 * The catalog store is the renderer's half of a two-writer contract: main owns the list and the
 * revision, the renderer only applies what it is sent. Two orderings have to hold for the picker to
 * be trustworthy, and neither is visible from the UI:
 *
 * - a read that started before a push must not overwrite it, or a slower `models:get-catalog` reply
 *   would blank the list a refresh had already delivered;
 * - an older push must not move the revision backwards, or a refresh that changed nothing could
 *   undo one that did.
 *
 * Only the store is real here; the bridge is a stub with a controllable reply.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function model(id: string) {
  return { id, name: id, provider: 'test', providerName: 'Test', contextWindow: 100, reasoning: false }
}

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })

  const replies: Array<ReturnType<typeof deferred<unknown>>> = []
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/ipc/api', () => ({
    api: {
      getModelCatalog: () => {
        const reply = deferred<unknown>()
        replies.push(reply)
        return reply.promise
      }
    }
  }))
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  const state = () => useModelCatalogStore.getState()

  const initialError = Object.assign(new Error('initial load failed'), { code: 'EACCES' })
  const initial = state().load()
  assert.equal(state().load(), initial, 'concurrent loads share a request')
  replies.at(-1)!.reject(initialError)
  await initial
  assert.equal(state().error, initialError.message)
  assert.deepEqual(state().models, [])
  assert.equal(state().loading, false)

  state().apply({ models: [model('one')], revision: 4, refreshing: false })
  assert.equal(state().revision, 4)

  // A push that is older than what is held is dropped: it would move the list backwards.
  state().apply({ models: [model('stale')], revision: 3, refreshing: false })
  assert.equal(state().revision, 4, 'an older revision is ignored')
  assert.deepEqual(state().models.map((item) => item.id), ['one'])

  // A read in flight while a push lands must keep the push, not the reply it started with.
  const read = state().load()
  state().apply({ models: [model('fresh')], revision: 5, refreshing: true })
  replies.at(-1)!.resolve({ models: [model('read-started-earlier')], revision: 4, refreshing: false })
  await read
  assert.equal(state().revision, 5, 'the newer push survives the older read')
  assert.deepEqual(state().models.map((item) => item.id), ['fresh'])
  assert.equal(state().refreshing, true, 'the pass in flight is still reported')

  // The pass end is applied like any other push, and it clears the spinner.
  state().apply({ models: [model('fresh')], revision: 5, refreshing: false })
  assert.equal(state().refreshing, false)

  const unchangedRead = state().load()
  state().apply({ models: [model('fresh')], revision: 5, refreshing: true })
  state().apply({ models: [model('fresh')], revision: 5, refreshing: false })
  replies.at(-1)!.resolve({ models: [model('fresh')], revision: 5, refreshing: true })
  await unchangedRead
  assert.equal(state().refreshing, false, 'a late equal-revision read cannot undo refresh completion')

  // A read that fails leaves what is held alone rather than clearing it.
  const failing = state().load()
  const readError = Object.assign(new Error('read failed'), { code: 'EACCES' })
  replies.at(-1)!.reject(readError)
  await failing
  assert.equal(state().error, readError.message, 'retaining data must not hide the failure')
  assert.equal(state().revision, 5, 'a failed read is not a change')
  assert.deepEqual(state().models.map((item) => item.id), ['fresh'], 'a failed read clears nothing')

  // A later read is a fresh request, not the shared one that already settled.
  const second = state().load()
  assert.equal(replies.length, 5, 'a settled read is not reused')
  replies.at(-1)!.resolve({ models: [model('newer')], revision: 6, refreshing: false })
  await second
  assert.equal(state().revision, 6)
  assert.equal(state().error, null, 'a successful retry clears the failure')
  assert.equal(state().loading, false)
  assert.deepEqual(state().models.map((item) => item.id), ['newer'])
}

if (process.argv[2] === '--catalog-store-fixture') {
  await fixture()
} else {
  test('catalog store: a newer push is never undone by an older read', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--catalog-store-fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 8_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(exitCode, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
    }
  })
}
