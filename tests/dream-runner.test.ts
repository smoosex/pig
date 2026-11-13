import { test, mock, spyOn } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, statSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-runner-fixture')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-dream-runner-')))
  mkdirSync(join(root, 'staged'))
  mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ fileMemory: { enabled: true } }) }))
  mock.module('../src/main/permissions/store', () => ({ sessionPermission: () => ({ mode: 'default' }) }))
  mock.module('../src/main/features/memory/long-term/access', () => ({ isChatMemoryCwd: () => false, memoryAccess: async () => ({ project: '/p', session: 's', cwd: '/p' }) }))
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const { createAssistantMessageEventStream, getCurrentTools } = await import('@earendil-works/pi-ai')
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') })
  runtime.registerProvider('dream-fixture', { api: 'openai-completions', baseUrl: 'http://unused.invalid', apiKey: 'fixture-only', models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
  await runtime.setRuntimeApiKey('dream-fixture', 'fixture-only')
  mock.module('../src/main/pi/model-settings', () => ({ startModelRuntime: async () => runtime,
    readDefaultSettings: async () => ({ effective: { model: { provider: 'dream-fixture', id: 'model' }, thinkingLevel: 'off' } }) }))
  let requests = 0
  let recover = false
  let longRun = false
  let projectAttempt: string | undefined
  let revision = ''
  const toolNames: string[][] = []
  const stream = spyOn(runtime, 'streamSimple').mockImplementation((model, context) => {
    toolNames.push(getCurrentTools(context.messages).map(tool => tool.name))
    const index = requests++
    const first = index === 0
    const toolsTurn = longRun ? index < 125 : first || (recover && index === 1)
    const repair = recover && index === 1
    const output = createAssistantMessageEventStream()
    output.push({ type: 'done', reason: toolsTurn ? 'toolUse' : 'stop', message: {
      role: 'assistant', timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id,
      content: longRun && toolsTurn ? [{ type: 'toolCall', id: `read-${index}`, name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } }] : first ? [
        { type: 'toolCall', id: 'read-index', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } },
        { type: 'toolCall', id: 'write-memory', name: 'memory_add', arguments: projectAttempt ? { scope: 'project', projectId: projectAttempt, path: 'project.md', content: 'Project clue' } : { scope: 'global', path: 'MEMORY.md', content: 'Useful clue' } }
      ] : repair ? [{ type: 'toolCall', id: 'repair-memory', name: 'memory_edit', arguments: { scope: 'global', path: 'MEMORY.md', revision, oldText: 'Useful clue', newText: 'Updated clue' } }] : [{ type: 'text', text: 'Reviewed and maintained memories.' }],
      stopReason: toolsTurn ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 7, cacheWrite: 3, totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    } })
    return output
  })
  try {
    const { DreamHistory } = await import('../src/main/features/memory/dream/history')
    const { runDreamWorker } = await import('../src/main/features/memory/dream/runner')
    const { MemoryFiles } = await import('../src/main/features/memory/long-term/files')
    const history = new DreamHistory([])
    let runs = 0
    const options = () => {
      if (existsSync(join(root, 'session.jsonl'))) renameSync(join(root, 'session.jsonl'), join(root, `previous-${runs}.jsonl`))
      runs++
      return { directory: root, topic: 'A useful clue', history, signal: new AbortController().signal,
        check: () => {}, progress: () => {}, usage: () => {} }
    }
    assert.match(await runDreamWorker(options()), /Reviewed/)
    const transcript = readFileSync(join(root, 'session.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(transcript[0].type, 'session')
    assert.ok(transcript.some(entry => entry.message?.role === 'user'))
    assert.ok(transcript.some(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'memory_add'))
    assert.ok(transcript.some(entry => entry.message?.role === 'assistant' && entry.message.stopReason === 'stop'))
    assert.equal(statSync(join(root, 'session.jsonl')).mode & 0o777, 0o600)
    assert.equal(statSync(root).mode & 0o777, 0o700)
    assert.equal(new MemoryFiles(join(root, 'staged', 'global'), join(root, 'staged')).read('MEMORY.md').content, 'Useful clue')
    const expected = ['dream_history_read', 'dream_history_search', 'dream_turn_tools', 'memory_add', 'memory_delete', 'memory_edit', 'memory_read'].sort()
    for (const names of toolNames) assert.deepEqual(names.sort(), expected, 'no shell, MCP, discovery, plugins, persona or unrelated tools')
    assert.equal(requests, 2)
    requests = 0
    await assert.rejects(runDreamWorker(options()), /DREAM_TOOL/, 'failed writes must not become a successful no-op')
    assert.ok(readFileSync(join(root, 'session.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).some(entry => entry.message?.role === 'toolResult' && entry.message.isError), 'failed runs retain their tool errors in the transcript')
    requests = 0; recover = true
    revision = new MemoryFiles(join(root, 'staged', 'global'), join(root, 'staged')).read('MEMORY.md').revision
    await runDreamWorker(options())
    assert.equal(new MemoryFiles(join(root, 'staged', 'global'), join(root, 'staged')).read('MEMORY.md').content, 'Updated clue', 'successful correction clears the failed mutation')
    requests = 0; recover = false; projectAttempt = 'a'.repeat(64)
    await assert.rejects(runDreamWorker(options()), /DREAM_TOOL/, 'fabricated project IDs cannot authorize project writes')
    projectAttempt = (await history.context({ id: 'p', cwd: root, path: '/unused', title: 'Project' })).projectId!
    requests = 0
    await runDreamWorker(options())
    assert.equal(new MemoryFiles(join(root, 'staged'), join(root, 'staged')).read('projects/' + projectAttempt + '/project.md').content, 'Project clue')
    requests = 0; longRun = true
    const observed: unknown[] = []
    await runDreamWorker({ ...options(), usage: usage => { observed.push(usage); return 'tokens' } })
    assert.ok(requests > 120, 'no model-turn cap remains')
    assert.deepEqual(observed[0], { input: 1, cacheRead: 7, cacheWrite: 3, output: 1, cost: null, requests: 1 })
    const wrapped = readFileSync(join(root, 'session.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(wrapped.filter(entry => entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes('reached 80%')).length, 1, 'wrap-up is delivered exactly once in the same run')
    const entered = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    const cancellation = new AbortController()
    const reason = new Error('DREAM_CANCELLED')
    requests = 0
    const configured = spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(false)
    const auth = spyOn(runtime, 'checkAuth').mockImplementation(async () => {
      entered.resolve(); await blocked.promise
      return { type: 'api_key' }
    })
    try {
      const work = runDreamWorker({ ...options(), signal: cancellation.signal })
      const outcome = work.then(() => undefined, error => error)
      await entered.promise
      cancellation.abort(reason)
      blocked.resolve()
      assert.equal(await outcome, reason, 'cancellation permanently invalidates an asynchronous preflight')
      assert.equal(requests, 0, 'cancelled preflight must never reach the provider')
      const cancelled = readFileSync(join(root, 'session.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(!cancelled.some(entry => entry.type === 'message'), 'no user input or run is committed after cancellation')
    } finally { blocked.resolve(); auth.mockRestore(); configured.mockRestore() }
  } finally { stream.mockRestore(); rmSync(root, { recursive: true, force: true }) }
} else test('real SDK Dream runtime exposes only the shared memory and history tools and maintains topic memories without requiring full-history reads', async () => {
  const result = await runSelf(import.meta.path, ['--dream-runner-fixture'], { timeoutMs: 20_000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
}, 25_000)
