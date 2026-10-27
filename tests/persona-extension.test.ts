import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type ExtensionAPI, type BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import personaExtension from '../src/main/plugins/pi-persona'
import { completedMoodRounds } from '../src/main/plugins/pi-persona/conversation'
import { getPersona, savePersonaFile, setPersonaMood, setPersonaAutomatic, setPersonaObserver } from '../src/main/plugins/pi-persona/service'
import { createPastedTextMetadata, PASTED_TEXT_CUSTOM_TYPE } from '../src/shared/pasted-text'

const model: Model<'openai-responses'> = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-responses',
  baseUrl: 'https://unused.invalid', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
function answer(text = '已完成', stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'thinking', thinking: 'INTERNAL SECRET' }, { type: 'text', text }],
    api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
let root: string
let previous: string | undefined
const cleanups: (() => Promise<void>)[] = []
beforeEach(async () => {
  previous = process.env.PIG_DIR
  root = await mkdtemp(join(tmpdir(), 'pig-persona-extension-'))
  process.env.PIG_DIR = root
  await savePersonaFile({ name: 'SOUL.md', content: 'Direct and playful, never cruel.', revision: null })
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  if (previous === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previous
  await rm(root, { recursive: true, force: true })
})
function runtime() {
  const session = SessionManager.inMemory()
  const rootId = session.appendCustomEntry('test-root')
  const hooks = new Map<string, (event: any, ctx: any) => Promise<any>>()
  let hold = false
  const requests: unknown[] = []
  const requestOptions: (SimpleStreamOptions | undefined)[] = []
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = []
  const sent: unknown[] = []
  const ctx: { model: Model<any> } & Record<string, unknown> = { sessionManager: session, model, hasPendingMessages: () => false,
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture' }),
      streamSimple(_model: unknown, context: unknown, options?: SimpleStreamOptions) {
        requests.push(context)
        requestOptions.push(options)
        const stream = createAssistantMessageEventStream()
        streams.push(stream)
        if (!hold) stream.end(answer(JSON.stringify({ changed: true, pleasantness: 2, activation: 1, feeling: '受到认可' })))
        return stream
      } },
  }
  personaExtension({ on: (name: string, callback: any) => { hooks.set(name, callback) },
    sendMessage: (message: unknown) => { sent.push(message) },
  } as unknown as ExtensionAPI)
  const emit = async (name: string, event: any = {}) => hooks.get(name)?.(event, ctx)
  const start = async () => {
    const sections: Record<string, string> = {}
    const result = await emit('before_agent_start', { messageType: 'user', prompt: 'hello', systemPromptOptions: { sections } }) as BeforeAgentStartEventResult
    if (result?.message) session.appendCustomMessageEntry(result.message.customType, result.message.content, false)
    return { result, sections }
  }
  const round = (user = '谢谢，帮大忙了') => { session.appendMessage({ role: 'user', content: user, timestamp: 0 }); return session.appendMessage(answer()) }
  cleanups.push(() => emit('session_shutdown'))
  return { session, rootId, emit, start, round, requests, requestOptions, sent, streams, hold: () => { hold = true },
    setModel: (next: Model<any>) => { ctx.model = next } }
}
async function drain(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Background observer did not settle')
}

test('projection contains only completed visible rounds and omits pasted attachment ranges', () => {
  const session = SessionManager.inMemory()
  const attachment = { id: 'paste', text: 'ATTACHMENT SECRET', byteSize: 17 }
  session.appendCustomEntry(PASTED_TEXT_CUSTOM_TYPE, createPastedTextMetadata('看看这个', [attachment]))
  session.appendMessage({ role: 'user', content: '看看这个\n\nATTACHMENT SECRET', timestamp: 0 })
  session.appendCustomMessageEntry('persona-mood', 'MOOD SECRET', false)
  session.appendMessage(answer('正在处理', 'toolUse'))
  session.appendMessage(answer('结果在这里'))
  session.appendMessage({ role: 'user', content: '未完成的问题', timestamp: 0 })
  const rounds = completedMoodRounds(session.buildSessionProjection().entries, session)
  expect(rounds).toHaveLength(1)
  expect(rounds[0]!.assistant).toBe('结果在这里')
  expect(rounds[0]!.user).toContain('看看这个')
  expect(JSON.stringify(rounds)).not.toMatch(/SECRET|正在处理|未完成/)
})

test('aborted and failed requests keep the user message with a marker, never a later reply', () => {
  const session = SessionManager.inMemory()
  session.appendMessage({ role: 'user', content: '取消前的问题', timestamp: 0 })
  session.appendMessage(answer('未完成', 'aborted'))
  session.appendMessage({ role: 'user', content: '失败的问题', timestamp: 0 })
  session.appendMessage(answer('出错', 'error'))
  session.appendMessage({ role: 'user', content: '新问题', timestamp: 0 })
  session.appendMessage(answer('新回复'))
  expect(completedMoodRounds(session.buildSessionProjection().entries, session).map(round => [round.user, round.assistant])).toEqual([
    ['取消前的问题', '[Reply interrupted by the user]'], ['失败的问题', '[Reply failed]'], ['新问题', '新回复']])
})

test('disabling the observer immediately cancels an idle background request', async () => {
  const run = runtime(); run.hold(); await run.emit('session_start')
  for (let i = 0; i < 3; i++) run.round()
  await run.emit('agent_settled')
  await drain(async () => run.requests.length === 1)
  await setPersonaObserver({ enabled: false })
  run.streams[0]!.end(answer(JSON.stringify({ changed: true, pleasantness: 1, activation: 1, feeling: 'stale' })))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await getPersona()).mood.history).toHaveLength(0)
  await setPersonaObserver({ enabled: true })
  await run.emit('agent_settled')
  expect(run.requests).toHaveLength(1)
})

test('style snapshots are append-only, restored after compaction, and old work triggers no longer affect mood', async () => {
  const run = runtime(); await run.emit('session_start')
  const first = await run.start()
  expect(first.sections.preamble).toContain('never cruel')
  expect(first.result.message?.content).toBe('[Expressive tone, relative to your personality: even-toned, steady, rested]')
  expect(first.sections.preamble).toContain('inserted by Pig, not written by the user')
  expect((await run.start()).result.message).toBeUndefined()
  const history = (await getPersona()).mood.history
  await run.emit('tool_result', { toolName: 'bash', isError: true, structuredContent: { exit_code: 1 } })
  expect((await getPersona()).mood.history).toEqual(history)
  const moodEntry = run.session.getLeafId()!
  run.session.branch(run.rootId)
  expect((await run.start()).result.message).toBeDefined()
  run.session.branch(moodEntry)
  expect((await run.start()).result.message).toBeUndefined()
})

test('three completed rounds are observed in background, applied once, and never start a main turn', async () => {
  const run = runtime(); run.round('旧历史不应重新分析')
  await run.emit('session_start')
  for (let i = 0; i < 3; i++) { run.round(); await run.emit('agent_settled') }
  await drain(async () => (await getPersona()).mood.history.length === 1)
  expect(run.requests).toHaveLength(1)
  expect(JSON.stringify(run.requests)).not.toContain('旧历史不应重新分析')
  expect((await getPersona()).mood.feeling).toBe('受到认可')
  expect(run.sent).toHaveLength(0)
  await run.emit('agent_settled')
  expect((await getPersona()).mood.history).toHaveLength(1)
})

test('the default observer sends no thinking and the SOUL; an explicit model sends its own effort', async () => {
  const run = runtime(); await run.emit('session_start')
  for (let i = 0; i < 3; i++) run.round()
  await run.emit('agent_settled'); await drain(async () => run.requests.length === 1)
  expect(run.requestOptions[0]?.reasoning).toBeUndefined()
  expect((run.requests[0] as { systemPrompt: string }).systemPrompt).toContain('never cruel')
  await setPersonaObserver({ enabled: true, provider: 'fixture', modelId: 'fixture', thinking: 'high' })
  for (let i = 0; i < 3; i++) run.round()
  await run.emit('agent_settled'); await drain(async () => run.requests.length === 2)
  expect(run.requestOptions[1]?.reasoning).toBe('high')
  await setPersonaObserver({ enabled: true, provider: 'fixture', modelId: 'fixture', thinking: 'off' })
  for (let i = 0; i < 3; i++) run.round()
  await run.emit('agent_settled'); await drain(async () => run.requests.length === 3)
  expect(run.requestOptions[2]?.reasoning).toBeUndefined()
})

test('switching the inherited model keeps queued rounds for the rebuilt observer', async () => {
  const run = runtime(); await run.emit('session_start')
  for (let i = 0; i < 2; i++) run.round()
  await run.emit('agent_settled')
  expect(run.requests).toHaveLength(0)
  run.setModel({ ...model, id: 'fixture-2' }); run.round()
  await run.emit('agent_settled'); await drain(async () => run.requests.length === 1)
  const scope = (run.requests[0] as { messages: { content: string }[] }).messages.at(-1)!.content
  expect(JSON.parse(scope).newRoundIds).toHaveLength(3)
})

test('a failed activity release still lets the next run register and renew', async () => {
  const run = runtime(); await run.emit('session_start')
  const file = join(root, 'persona', 'mood-state.json')
  const state = async () => JSON.parse(await readFile(file, 'utf8')).activeSessions as Record<string, number>
  await run.emit('agent_start')
  const [first] = Object.values(await state())
  const saved = await readFile(file, 'utf8')
  await writeFile(file, '{corrupt')
  try { await expect(run.emit('agent_end')).rejects.toThrow() }
  finally { await writeFile(file, saved) }
  await new Promise(resolve => setTimeout(resolve, 5))
  await run.emit('agent_start')
  expect(Object.values(await state())[0]).toBeGreaterThan(first!)
  await run.emit('agent_end')
  expect(await state()).toEqual({})
})

test('late observer results cannot overwrite manual changes or survive branch navigation', async () => {
  const run = runtime(); run.hold(); await run.emit('session_start')
  for (let i = 0; i < 3; i++) run.round()
  await run.emit('agent_settled')
  await drain(async () => run.requests.length === 1)
  await setPersonaMood({ pleasantness: -0.7, activation: 0.2, energy: 0.6 })
  run.streams[0]!.end(answer(JSON.stringify({ changed: true, pleasantness: 1, activation: 1, feeling: 'stale' })))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await getPersona()).mood.history.map(entry => entry.trigger)).toEqual(['manual_set'])
  run.session.branch(run.rootId); await run.emit('session_tree')
  await setPersonaAutomatic(false)
  expect((await run.start()).result.message).toBeDefined()
  expect((await getPersona()).mood.feeling).not.toBe('stale')
})
