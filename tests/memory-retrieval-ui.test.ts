import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SystemUIEvent } from '../src/shared/api'
import type { LongTermRetrievalTrace } from '../src/shared/long-term-memory'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  document.insertBefore(document.implementation.createDocumentType('html', '', ''), document.documentElement)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let listener = (_event: SystemUIEvent) => {}
  Object.assign(window, { api: { onSystemUI: (next: typeof listener) => { listener = next; return () => {} } } })
  const { act, createElement: h, Fragment } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { SystemPluginUI } = await import('../src/renderer/src/components/SystemPluginUI')
  const { ProcessOutline, ProcessList } = await import('../src/renderer/src/components/turn/TurnProcess')
  const { TurnView } = await import('../src/renderer/src/components/TurnView')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { withMemoryRetrieval } = await import('../src/renderer/src/chat/memory-retrieval')
  const { buildTurn, renderKeyForUser } = await import('../src/renderer/src/chat/turns')
  const { clusterWork, processSegments } = await import('../src/renderer/src/components/turn/process-model')
  useSettingsStore.setState({ locale: 'zh-CN', localeSetting: 'zh-CN' })
  useSessionsStore.setState({ runtime: { session: emptyRuntime() } })
  const user = { role: 'user' as const, content: '查找旧项目决定', timestamp: 100 }
  const trace: LongTermRetrievalTrace = { id: 'request', turnId: 'source-user', renderKey: renderKeyForUser(user), status: 'running', memories: [] }
  const done: LongTermRetrievalTrace = { ...trace, status: 'done', durationMs: 12,
    memories: [{ id: 'memory', content: '<script>not executable</script> 项目决定使用 bun', scope: 'project', status: 'disputed' }] }
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  const render = async (value: LongTermRetrievalTrace, history = false) => {
    const items = [{ kind: 'memory' as const, retrieval: value }]
    await act(async () => { root.render(h(TooltipProvider, null, h(Fragment, null,
      h(SystemPluginUI, { activeSessionId: null }), history ? h(ProcessList, { items })
        : h(ProcessOutline, { items, streaming: true, waitingForModel: false })))) })
    await flush()
  }
  try {
    await render(trace)
    assert.ok(document.querySelector('[data-memory-retrieval="running"]'))
    assert.ok(host.textContent!.includes('正在召回记忆'))
    await act(async () => { listener({ kind: 'memory-retrieval', sessionId: 'session', trace }) })
    assert.equal(useSessionsStore.getState().runtime.session!.memoryRetrievals['source-user']!.id, 'request')
    await act(async () => { listener({ kind: 'memory-retrieval', sessionId: 'session', trace: done }) })
    assert.equal(useSessionsStore.getState().runtime.session!.memoryRetrievals['source-user']!.status, 'done')
    await render(done)
    assert.ok(host.textContent!.includes('已召回 1 条记忆'))
    assert.ok(host.textContent!.includes('12 毫秒'))
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-memory-retrieval] button')!.click() }); await flush()
    assert.ok(host.textContent!.includes('项目决定使用 bun'))
    assert.ok(host.textContent!.includes('项目'))
    assert.ok(host.textContent!.includes('存在冲突'))
    assert.equal(document.querySelector('script'), null)
    await render({ ...done, memories: [] })
    assert.ok(host.textContent!.includes('未找到相关记忆'))
    await render({ ...done, status: 'error', memories: [] })
    assert.ok(host.textContent!.includes('记忆召回失败'))
    await render({ ...done, status: 'cancelled', memories: [] })
    assert.ok(host.textContent!.includes('记忆召回已取消'))
    await render(done, true)
    assert.ok(host.textContent!.includes('已召回 1 条记忆'), 'completed work still has a standalone recall row')
    assert.equal(clusterWork([{ kind: 'memory', retrieval: done }])[0]!.kind, 'memory', 'host activity is never fabricated model thinking')
    assert.equal(processSegments([{ kind: 'memory', retrieval: done }, { kind: 'tools', tools: [] }]).length, 2)

    const actions = useSessionsStore.getState()
    actions.setMemoryRetrieval('session', { ...trace, id: 'new' })
    actions.setMemoryRetrieval('session', done)
    assert.equal(useSessionsStore.getState().runtime.session!.memoryRetrievals['source-user']!.id, 'new', 'late old completion cannot overwrite a new request')
    actions.clearMemoryRetrievals('session')
    actions.setMemoryRetrieval('session', { ...done, id: 'new' })
    assert.deepEqual(useSessionsStore.getState().runtime.session!.memoryRetrievals, {}, 'reset cannot be undone by a late completion')
    for (let i = 0; i < 40; i++) actions.setMemoryRetrieval('session', { ...trace, id: String(i), turnId: String(i) })
    assert.equal(Object.keys(useSessionsStore.getState().runtime.session!.memoryRetrievals).length, 32)
    actions.setMemoryRetrieval('closed-session', trace)
    assert.equal(useSessionsStore.getState().runtime['closed-session'], undefined)
    const base = { ...buildTurn([user], false, {}, trace.renderKey), id: 'source-user' }
    const decorated = withMemoryRetrieval(base, { 'source-user': done })
    assert.equal(decorated.memoryRetrieval, done)
    assert.equal(decorated.process, base.process, 'diagnostics cannot mark a lazy process body as already loaded')
    assert.equal(withMemoryRetrieval({ ...base, id: 'another-branch-user' }, { 'source-user': done }).memoryRetrieval, undefined)
    assert.equal(withMemoryRetrieval({ ...base, id: 'live:prompt' }, { 'source-user': done }).memoryRetrieval, done)
    let loads = 0
    await act(async () => { root.render(h(TooltipProvider, null, h(TurnView, {
      turn: { ...decorated, workBlocks: [true, true], compactions: [{ kind: 'compaction', text: '', tokensBefore: 100,
        afterAnswer: false, workMsBefore: 10, durationMs: 10 }] },
      onNeedProcess: async () => { loads++ },
    }))) }); await flush()
    const headers = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.startsWith('耗时'))
    assert.equal(headers.length, 2, 'recall metadata must not hide projected work across a compaction')
    await act(async () => { headers[0]!.click() }); await flush()
    assert.equal(loads, 1, 'expanding history still reads the original process body')
    assert.ok(host.textContent!.includes('已召回 1 条记忆'))
  } finally { await act(async () => { root.unmount() }); GlobalRegistrator.unregister() }
}
if (process.argv.includes('--fixture')) await fixture()
else test('recall diagnostics render separately, follow UI events and reject stale/closed-session results without polluting lazy history', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 12_000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 15_000)
