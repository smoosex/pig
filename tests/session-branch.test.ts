import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { PASTED_TEXT_CUSTOM_TYPE } from '../src/shared/pasted-text'
import { normalizeSessionPrompt } from '../src/main/pi/prompt-input'
import { restoreSessionUserPrompt } from '../src/main/pi/session-user-prompt'
import { switchSessionBranch } from '../src/main/pi/session-branch'

function fixture() {
  const sessionManager = SessionManager.inMemory('/project')
  const events: unknown[] = []
  let refreshes = 0
  const session = {
    sessionManager,
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    refreshContext: () => { refreshes++ },
    extensionRunner: { emit: async (event: unknown) => { events.push(event) } }
  } as unknown as Parameters<typeof switchSessionBranch>[0]
  return { session, sessionManager, events, refreshes: () => refreshes }
}

const user = (text: string) => ({ role: 'user' as const, content: text, timestamp: 1 })

test('tree restores a user prompt before its sent message without modifying the old branch', async () => {
  const { session, sessionManager: sm, events, refreshes } = fixture()
  const first = sm.appendMessage(user('第一轮'))
  const parent = sm.appendCustomEntry('checkpoint', {})
  const target = sm.appendMessage(user('第二轮\n继续'))
  const oldLeaf = sm.appendCustomEntry('checkpoint', {})
  const entries = sm.getEntries()
  const result = await switchSessionBranch(session, target, { restoreUserInput: true })
  assert.deepEqual(result, { leafId: parent, restoredPrompt: { text: '第二轮\n继续', images: [] } })
  assert.deepEqual(sm.getBranch().map((entry) => entry.id), [first, parent])
  assert.deepEqual(sm.getEntries(), entries)
  assert.equal(refreshes(), 1)
  assert.deepEqual(events, [{ type: 'session_tree', newLeafId: parent, oldLeafId: oldLeaf }])
  const resent = sm.appendMessage(user('修改后的第二轮'))
  assert.equal(sm.getEntry(resent)?.parentId, parent)
  assert.ok(sm.getEntry(target), 'the original sent prompt remains available in the tree')
})

test('restoring the first user node resets to an empty branch, even when it is the current leaf', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage(user('首轮问题'))
  const result = await switchSessionBranch(session, target, { restoreUserInput: true })
  assert.deepEqual(result, { leafId: null, restoredPrompt: { text: '首轮问题', images: [] } })
  assert.deepEqual(sm.getBranch(), [])
})

test('tree restoration retains all text blocks and image payloads', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage({
    role: 'user', timestamp: 1,
    content: [
      { type: 'text', text: '图片说明\n' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      { type: 'text', text: '粘贴的完整内容' }
    ]
  })
  const { restoredPrompt } = await switchSessionBranch(session, target, { restoreUserInput: true })
  assert.deepEqual(restoredPrompt, {
    text: '图片说明\n粘贴的完整内容',
    images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }]
  })
})

test('branch synchronization keeps a user node sent, and non-user restoration does not replace the draft', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage(user('已发送'))
  const other = sm.appendCustomEntry('checkpoint', {})
  assert.deepEqual(await switchSessionBranch(session, target), { leafId: target })
  assert.equal(sm.getBranch().at(-1)?.id, target)
  assert.deepEqual(await switchSessionBranch(session, other, { restoreUserInput: true }), { leafId: other })
})

function summarizedFixture() {
  const base = fixture()
  const preparations: unknown[] = []
  const session = Object.assign(base.session, {
    model: {},
    _extensionRunner: {
      hasHandlers: () => true,
      emit: async (event: { type: string; preparation?: unknown }) => {
        if (event.type === 'session_before_tree') {
          preparations.push(event.preparation)
          return { summary: { summary: 'SDK branch summary' } }
        }
        base.events.push(event)
        return undefined
      }
    },
    _refreshFinalizedContext: base.session.refreshContext,
    _restoreToolsFromTranscript: () => {},
    _resolveIdleWaitIfIdle: () => {},
    navigateTree: AgentSession.prototype.navigateTree
  })
  return { ...base, session, preparations }
}

for (const customInstructions of [undefined, '保留关键决策']) {
  test(`summarized user navigation uses SDK summary leaf and restores attachments (${customInstructions ?? 'default'})`, async () => {
    const { session, sessionManager: sm, preparations, events } = summarizedFixture()
    const parent = sm.appendCustomEntry('checkpoint', {})
    const prompt = normalizeSessionPrompt({ text: '说明', textAttachments: [{ id: 'paste', text: '附加内容' }] })
    const metadataId = sm.appendCustomEntry(PASTED_TEXT_CUSTOM_TYPE, prompt.metadata)
    const target = sm.appendMessage({
      role: 'user', timestamp: 1,
      content: [{ type: 'text', text: prompt.modelText }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })
    const expected = restoreSessionUserPrompt(sm, sm.getEntry(target)!).prompt
    assert.equal(expected.textAttachments?.[0]?.text, '附加内容')
    const oldLeaf = sm.appendCustomEntry('checkpoint', {})
    const result = await switchSessionBranch(session, target, {
      restoreUserInput: true, summarize: true,
      ...(customInstructions ? { customInstructions } : {})
    })
    const summary = sm.getEntry(result.leafId!)
    assert.equal(summary?.type, 'branch_summary')
    assert.equal(summary?.parentId, metadataId, 'keep the actual SDK navigation position, not the lightweight restoration parent')
    if (summary?.type === 'branch_summary') {
      assert.equal(summary.summary, 'SDK branch summary')
      assert.equal(summary.fromId, oldLeaf)
    }
    assert.ok(sm.getEntry(parent))
    assert.deepEqual(result.restoredPrompt, expected, 'summaries keep pasted-text attachments and images editable')
    assert.deepEqual(result.restoredPrompt?.images, [{ mimeType: 'image/png', data: 'aW1hZ2U=' }])
    assert.equal((preparations[0] as { customInstructions?: string }).customInstructions, customInstructions)
    assert.equal(events.length, 1, 'SDK alone emits the tree event')
  })
}

test('SDK summaries at the first user attach to root and are never overwritten', async () => {
  const { session, sessionManager: sm } = summarizedFixture()
  const target = sm.appendMessage(user('首轮'))
  sm.appendCustomEntry('checkpoint', {})
  const result = await switchSessionBranch(session, target, { summarize: true, restoreUserInput: true })
  assert.equal(sm.getEntry(result.leafId!)?.type, 'branch_summary')
  assert.equal(sm.getEntry(result.leafId!)?.parentId, null)
})

test('summarizing the current user still restores it when SDK navigation is a no-op', async () => {
  const { session, sessionManager: sm } = summarizedFixture()
  const target = sm.appendMessage(user('首轮'))
  assert.deepEqual(await switchSessionBranch(session, target, { summarize: true, restoreUserInput: true }), {
    leafId: null, restoredPrompt: { text: '首轮', images: [] }
  })
})

test('cancelled or aborted SDK navigation preserves leaf and draft; errors propagate and allow retry', async () => {
  const { session, sessionManager: sm } = summarizedFixture()
  const target = sm.appendMessage(user('问题'))
  const oldLeaf = sm.appendCustomEntry('checkpoint', {})
  for (const result of [{ cancelled: true }, { cancelled: false, aborted: true }]) {
    session.navigateTree = async () => result
    assert.deepEqual(await switchSessionBranch(session, target, { summarize: true, restoreUserInput: true }), {
      leafId: oldLeaf, cancelled: true
    })
  }
  session.navigateTree = async () => { throw new Error('summary failed') }
  await assert.rejects(switchSessionBranch(session, target, { summarize: true }), /summary failed/)
  assert.equal(sm.getLeafId(), oldLeaf)
  session.navigateTree = AgentSession.prototype.navigateTree
  assert.equal(sm.getEntry((await switchSessionBranch(session, target, { summarize: true })).leafId!)?.type, 'branch_summary')
})

test('a stop before Pi starts the summary cancels it; a stop during the summary reaches Pi', async () => {
  const { session, sessionManager: sm } = summarizedFixture()
  const target = sm.appendMessage(user('问题'))
  const oldLeaf = sm.appendCustomEntry('checkpoint', {})
  let navigations = 0
  const real = session.navigateTree
  session.navigateTree = async (...args) => { navigations++; return real.apply(session, args) }
  const early = new AbortController()
  early.abort()
  assert.deepEqual(await switchSessionBranch(session, target, { summarize: true, restoreUserInput: true }, early.signal), {
    leafId: oldLeaf, cancelled: true
  })
  assert.equal(navigations, 0, 'an early stop never starts a summary')
  assert.equal(sm.getEntries().some((entry) => entry.type === 'branch_summary'), false)

  const late = new AbortController()
  let aborts = 0
  session.abortBranchSummary = () => { aborts++ }
  session.navigateTree = async () => { late.abort(); return { cancelled: true, aborted: true } }
  assert.deepEqual(await switchSessionBranch(session, target, { summarize: true }, late.signal), { leafId: oldLeaf, cancelled: true })
  assert.equal(aborts, 1, 'a stop while summarizing is forwarded to Pi')
  late.signal.dispatchEvent(new Event('abort'))
  assert.equal(aborts, 1, 'the listener is removed once navigation settles')
})

test('invalid navigation options fail before changing the tree', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage(user('问题'))
  for (const options of [
    { summarize: 'yes' }, { restoreUserInput: 1 },
    { summarize: true, customInstructions: 1 }, { summarize: true, customInstructions: '  ' },
    { summarize: false, customInstructions: 'preserve decisions' }
  ]) {
    await assert.rejects(switchSessionBranch(session, target, options as never), /boolean|string|requires/)
    assert.equal(sm.getLeafId(), target)
  }
})

test('busy sessions reject restoration without moving the leaf', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage(user('问题'))
  for (const state of [
    { isStreaming: true }, { isBashRunning: true }, { isCompacting: true }
  ]) {
    await assert.rejects(switchSessionBranch({ ...session, ...state }, target, { restoreUserInput: true }), /Session is busy/)
    assert.equal(sm.getLeafId(), target)
  }
})
