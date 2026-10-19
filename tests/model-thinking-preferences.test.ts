/** Exercise shared preference resolution and persistence without touching the user's Pi settings. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { LiveSession, MemorySession } from '../src/main/pi/session-state'
import type { ThinkingLevel } from '../src/shared/api'

async function fixture() {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const models = ['a', 'b', 'plain'].map((id) => ({ id, provider: 'test', name: id, contextWindow: 1000, reasoning: id !== 'plain' }))
  let stored = JSON.stringify({ defaultThinkingLevel: 'medium', modelThinkingLevels: { 'test/b': 'high' } })
  let failWrite = false
  let failRead = false
  let denyReadAfterWriteFailure = false
  const SettingsManager = sdk.SettingsManager
  const createSettings = () => SettingsManager.fromStorage({
    withLock(scope, fn) {
      if (failRead) throw new Error('Settings are unreadable')
      const next = fn(scope === 'global' ? stored : undefined)
      if (next !== undefined) {
        if (failWrite) {
          if (denyReadAfterWriteFailure) failRead = true
          throw new Error('Disk is read-only')
        }
        stored = next
      }
    }
  })
  let settings = createSettings()
  mock.module('@earendil-works/pi-coding-agent', () => ({
    ...sdk,
    SettingsManager: { create: () => { settings = createSettings(); return settings } },
    ModelRuntime: { create: async () => ({
      getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAvailableSnapshot: () => models,
      getProvider: () => undefined
    }) }
  }))
  const { controlsFor, setSessionModel, setSessionThinking, setSessionModelThinkingPreference, applyPendingControls } = await import('../src/main/pi/session-controls')
  const manager = sdk.SessionManager.inMemory('/project')
  manager.appendModelChange('test', 'a')
  manager.appendThinkingLevelChange('high')
  const pending = {
    kind: 'memory', cwd: '/project', sessionId: 'pending', sessionManager: manager,
    win: {}, modelProvider: 'test', modelId: 'a'
  } as MemorySession
  const agent = {
    model: models[0]!, thinkingLevel: 'high' as ThinkingLevel,
    setModel: async (model: typeof models[number]) => { agent.model = model },
    setThinkingLevel: (level: ThinkingLevel) => { agent.thinkingLevel = level },
    getAvailableThinkingLevels: () => agent.model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'],
    getContextUsage: () => null,
    getFollowUpMessages: () => [], getSteeringMessages: () => []
  }
  const live = { agentSession: agent } as unknown as LiveSession
  assert.equal((await controlsFor(pending)).thinkingLevel, 'high', 'history restoration keeps its recorded level, not the global default')

  settings.setDefaultThinkingLevel('xhigh')
  pending.thinkingLevel = 'xhigh'
  agent.thinkingLevel = 'xhigh'
  for (const session of [pending, live]) {
    assert.equal((await setSessionModel(session, 'test', 'a')).thinkingLevel, 'high', 'xhigh adapts to the target’s high cap, not its lowest level')
  }
  settings.setDefaultThinkingLevel('medium')
  settings.setModelThinkingLevel('test', 'b', 'xhigh')
  for (const session of [pending, live]) {
    assert.equal((await setSessionModel(session, 'test', 'b')).thinkingLevel, 'high', 'unsupported saved model preferences use SDK adaptation too')
  }
  settings.setModelThinkingLevel('test', 'b', 'high')

  for (const target of ['b', 'a', 'plain', 'b']) {
    const cold = await setSessionModel(pending, 'test', target)
    const warm = await setSessionModel(live, 'test', target)
    assert.equal(cold.thinkingLevel, warm.thinkingLevel, 'live and pending model switches resolve the same level')
    assert.equal(cold.thinkingLevel, target === 'b' ? 'high' : target === 'a' ? 'medium' : 'off')
  }
  await setSessionModel(pending, 'test', 'a')
  await setSessionModel(live, 'test', 'a')
  await setSessionThinking(pending, 'low')
  assert.equal((await controlsFor(pending)).modelThinkingLevel, null, 'an ordinary adjustment is session-only')
  assert.equal(settings.getModelThinkingLevel('test', 'a'), undefined)
  const remembered = await setSessionModelThinkingPreference(pending, true)
  assert.equal(remembered.modelThinkingLevel, 'low')
  assert.equal(settings.getDefaultThinkingLevel(), 'medium', 'remembering a model never changes the global default')
  assert.equal(JSON.parse(stored).modelThinkingLevels['test/a'], 'low')

  await setSessionModel(live, 'test', 'a')
  assert.equal(agent.thinkingLevel, 'low', 'an already-live tab sees the other tab’s saved preference')
  await setSessionThinking(live, 'high')
  assert.equal(settings.getModelThinkingLevel('test', 'a'), 'high', 'explicit changes update an existing preference')
  agent.setThinkingLevel('low')
  assert.equal(settings.getModelThinkingLevel('test', 'a'), 'high', 'SDK/plugin temporary adjustments never write preferences')
  await applyPendingControls(pending, agent as unknown as LiveSession['agentSession'])
  assert.equal(agent.thinkingLevel, 'low', 'materialization keeps the pending session’s explicit level')
  assert.equal(settings.getModelThinkingLevel('test', 'a'), 'high', 'materialization does not save preferences')

  const forgotten = await setSessionModelThinkingPreference(live, false)
  assert.equal(forgotten.modelThinkingLevel, null)
  assert.equal(forgotten.thinkingLevel, 'low', 'forgetting does not change the current session')
  assert.equal(JSON.parse(stored).modelThinkingLevels['test/a'], undefined)
  await setSessionModel(live, 'test', 'a')
  assert.equal(agent.thinkingLevel, 'medium', 'future switches inherit the global default after forgetting')
  failWrite = true
  await assert.rejects(setSessionModelThinkingPreference(live, true), /Could not save thinking preferences/)
  assert.equal((await controlsFor(live)).modelThinkingLevel, null, 'failed writes cannot leave phantom preferences in memory')
  denyReadAfterWriteFailure = true
  await assert.rejects(setSessionModelThinkingPreference(live, true), /Could not save thinking preferences/)
  await assert.rejects(controlsFor(live), /Could not reload thinking preferences/, 'unreadable recovery must not expose the phantom value')
  await assert.rejects(setSessionModelThinkingPreference(live, true), /Could not reload thinking preferences/, 'unreadable recovery cannot report a false save success')
  failRead = false
  failWrite = false
  await setSessionModelThinkingPreference(live, true)
  await assert.rejects(setSessionThinking(live, 'xhigh'), /not supported/)
  assert.equal(settings.getModelThinkingLevel('test', 'a'), 'medium', 'invalid choices cannot overwrite a saved preference')
}

if (process.argv.includes('--fixture')) await fixture()
else test('model thinking preferences are consistent, opt-in, durable and isolated from temporary changes', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stderr || stdout)
  } finally { clearTimeout(timeout); child.kill() }
})
