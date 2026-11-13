/** Request bookkeeping is shared; ownership and answer validation remain with each IPC handler. */
import { spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { requestReply, type PendingReply } from '../src/main/ipc/pending-reply'

type Request = PendingReply<string> & { owner: string }
const options = { timeoutMs: 1000, timeoutMessage: 'Reply timed out' }

test('a reply retains metadata and settles once, removing bookkeeping and abort listeners', async () => {
  const pending = new Map<string, Request>()
  const controller = new AbortController()
  const remove = spyOn(controller.signal, 'removeEventListener')
  try {
    let reply!: Request
    const result = requestReply(pending, { owner: 'window' }, id => {
      reply = pending.get(id)!
      assert.equal(reply.owner, 'window')
      reply.settle('answer')
      reply.fail(new Error('Late failure'))
      reply.settle('late answer')
    }, { ...options, signal: controller.signal })
    assert.equal(await result, 'answer')
    assert.equal(pending.size, 0)
    assert.equal(remove.mock.calls.length, 1)
    controller.abort()
    assert.equal(remove.mock.calls.length, 1)
  } finally { remove.mockRestore() }
})

test('send failures and explicit failures both clean up the request', async () => {
  for (const sendingFails of [true, false]) {
    const pending = new Map<string, Request>()
    const controller = new AbortController()
    const remove = spyOn(controller.signal, 'removeEventListener')
    const error = new Error('Request failed')
    try {
      await assert.rejects(requestReply(pending, { owner: 'window' }, id => {
        if (sendingFails) throw error
        pending.get(id)!.fail(error)
      }, { ...options, signal: controller.signal }), failure => failure === error)
      assert.equal(pending.size, 0)
      assert.equal(remove.mock.calls.length, 1)
    } finally { remove.mockRestore() }
  }
})

test('cancellation prevents sending or invalidates pending replies while preserving the selected reason', async () => {
  const pending = new Map<string, Request>()
  const cancelled = new AbortController()
  const reason = new Error('Cancelled')
  cancelled.abort(reason)
  assert.throws(() => requestReply(pending, { owner: 'window' }, () => {
    assert.fail('An already cancelled request must not be sent')
  }, { ...options, signal: cancelled.signal }), failure => failure === reason)
  assert.equal(pending.size, 0)

  for (const cancelError of [undefined, new Error('Session UI request was cancelled')]) {
    const controller = new AbortController()
    let reply!: Request
    const result = requestReply(pending, { owner: 'window' }, id => { reply = pending.get(id)! }, {
      ...options, signal: controller.signal, cancelError
    })
    controller.abort(reason)
    await assert.rejects(result, failure => failure === (cancelError ?? reason))
    assert.equal(pending.size, 0)
    reply.settle('late answer')
    reply.fail(new Error('Late failure'))
    assert.equal(pending.size, 0)
  }
})

test('timeouts retire pending replies and detach abort listeners', async () => {
  const pending = new Map<string, Request>()
  const controller = new AbortController()
  const remove = spyOn(controller.signal, 'removeEventListener')
  try {
    let reply!: Request
    const result = requestReply(pending, { owner: 'window' }, id => { reply = pending.get(id)! }, {
      ...options, timeoutMs: 1, signal: controller.signal
    })
    await assert.rejects(result, /Reply timed out/)
    assert.equal(pending.size, 0)
    assert.equal(remove.mock.calls.length, 1)
    reply.settle('late answer')
    assert.equal(pending.size, 0)
  } finally { remove.mockRestore() }
})
