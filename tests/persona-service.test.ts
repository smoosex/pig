import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PERSONA_FILES } from '../src/shared/persona'
import { getPersona, savePersonaFile, setPersonaAutomatic, setPersonaEmotion } from '../src/main/plugins/pi-persona/service'
import personaExtension from '../src/main/plugins/pi-persona'
import { withPersonaLock } from '../src/main/plugins/pi-persona/storage'
import { convertToLlm, SessionManager, type BeforeAgentStartEventResult, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

let root: string
let oldPig: string | undefined
beforeEach(async () => {
  oldPig = process.env.PIG_DIR
  root = await mkdtemp(join(tmpdir(), 'pig-persona-'))
  process.env.PIG_DIR = join(root, 'pig')
})
afterEach(async () => {
  if (oldPig === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = oldPig
  await rm(root, { recursive: true, force: true })
})
async function activate(): Promise<void> {
  await savePersonaFile({ name: 'SOUL.md', content: 'A helpful familiar.', revision: null })
}
function runtime(session = SessionManager.inMemory()) {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
  const sent: { message: NonNullable<BeforeAgentStartEventResult['message']>; options: unknown }[] = []
  const queued = { pending: false }
  personaExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { hooks.set(name, handler) },
    sendMessage: (message: NonNullable<BeforeAgentStartEventResult['message']>, options: unknown) => { sent.push({ message, options }) },
  } as unknown as ExtensionAPI)
  return Object.assign(async (name: string, event: unknown = {}) => {
    if (name !== 'before_agent_start') return await hooks.get(name)!(event, { sessionManager: session, hasPendingMessages: () => queued.pending })
    const sections: Record<string, string> = {}
    const result = await hooks.get(name)!({ ...event as object, systemPromptOptions: { sections } }, { sessionManager: session, hasPendingMessages: () => queued.pending }) as BeforeAgentStartEventResult | undefined
    const message = result?.message
    if (message) session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details)
    return result && { ...result, persona: sections.persona, preamble: sections.preamble }
  }, { session, sent, queued })
}

test('defaults, revisions, private permissions and empty SOUL disabling', async () => {
  const initial = await getPersona()
  expect(initial.active).toBe(false)
  expect(initial.mood.emotion).toBe('joy')
  expect(initial.mood.intensity).toBe(0.15)
  expect(initial.mood.automatic).toBe(true)
  expect(initial.files.every(file => file.revision === null)).toBe(true)
  await activate()
  const saved = await getPersona()
  expect(saved.active).toBe(true)
  const soul = saved.files.find(file => file.name === 'SOUL.md')!
  expect(soul.revision).toMatch(/^[a-f0-9]{64}$/)
  expect((await stat(join(process.env.PIG_DIR!, 'persona'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(process.env.PIG_DIR!, 'persona/SOUL.md'))).mode & 0o777).toBe(0o600)
  expect((await savePersonaFile({ ...soul, content: '' })).active).toBe(false)
  await expect(savePersonaFile({ ...soul, content: 'Stale overwrite' })).rejects.toThrow('conflict')
})

test('strict document validation rejects malformed YAML, unsafe engines, traits, metadata and size', async () => {
  for (const content of ['---\nname: [broken\n---', '---\nname: test', '---\nname: 42\n---', '---\nextraversion: nope\n---', '---\nsarcasm: 2\n---', '---javascript\n({name: "x"})\n---']) {
    await expect(savePersonaFile({ name: 'IDENTIFY.md', content, revision: null })).rejects.toThrow()
  }
  await expect(savePersonaFile({ name: '../SOUL.md', content: 'x', revision: null } as never)).rejects.toThrow('Invalid')
  await expect(savePersonaFile({ name: 'USER.md', content: 'a'.repeat(256 * 1024 + 1), revision: null })).rejects.toThrow('256 KiB')
  await savePersonaFile({ name: 'IDENTIFY.md', content: '---\n---\n', revision: null })
  expect((await getPersona()).active).toBe(false)
})

test('BOM-prefixed documents cannot select executable frontmatter engines', async () => {
  const probe = globalThis as typeof globalThis & { __personaUnsafe?: boolean }
  for (const name of PERSONA_FILES) {
    await expect(savePersonaFile({
      name, revision: null,
      content: '\uFEFF---javascript\n(globalThis.__personaUnsafe = true, {name: "probe"})\n---\nBody'
    })).rejects.toThrow('Only YAML')
    expect(probe.__personaUnsafe).toBeUndefined()
  }
  await savePersonaFile({ name: 'IDENTIFY.md', content: '\uFEFF---\nname: BOM persona\n---\n', revision: null })
  await activate()
  expect((await getPersona()).active).toBe(true)
})

test('manual controls work without live sessions, share disk state, freeze decay and cap history', async () => {
  await setPersonaAutomatic(false)
  await setPersonaEmotion('anger', 0.9)
  const file = join(process.env.PIG_DIR!, 'persona/mood-state.json')
  const disk = JSON.parse(await readFile(file, 'utf8'))
  disk.lastInteraction = Date.now() - 86400000
  await writeFile(file, JSON.stringify(disk))
  expect((await getPersona()).mood.intensity).toBe(0.9)
  await Promise.all(Array.from({ length: 8 }, (_, index) => setPersonaEmotion('trust', index / 10)))
  for (let index = 0; index < 45; index++) await setPersonaEmotion('joy', 0.8)
  expect((await getPersona()).mood.history).toHaveLength(50)
  expect((await setPersonaAutomatic(true)).mood.intensity).toBe(0.8)
  await expect(setPersonaEmotion('joy', NaN)).rejects.toThrow()
})

test('independent module processes serialize global history through the disk lock', async () => {
  const service = new URL('../src/main/plugins/pi-persona/service.ts', import.meta.url).pathname
  const script = `import { setPersonaEmotion } from ${JSON.stringify(service)}; for (let i = 0; i < 4; i++) await setPersonaEmotion('trust', 0.6);`
  const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, PIG_DIR: process.env.PIG_DIR! }, stdout: 'pipe', stderr: 'pipe',
  }))
  for (const child of children) {
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
  }
  const saved = await getPersona()
  expect(saved.mood.history).toHaveLength(8)
  const state = JSON.parse(await readFile(join(process.env.PIG_DIR!, 'persona/mood-state.json'), 'utf8'))
  expect(state.nextHistorySequence).toBe(9)
})

test('non-ENOENT I/O and invalid disk JSON are not replaced with defaults or local success', async () => {
  await activate()
  const file = join(process.env.PIG_DIR!, 'persona/mood-state.json')
  await writeFile(file, '{broken')
  await expect(getPersona()).rejects.toThrow()
  await expect(setPersonaEmotion('anger', 1)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('{broken')
  await rm(file)
  await mkdir(join(process.env.PIG_DIR!, 'persona/USER.md'))
  await expect(getPersona()).rejects.toThrow()
  delete process.env.PIG_DIR
  await expect(getPersona()).rejects.toThrow('PIG_DIR')
})

test('mood snapshots append without changing the system prompt or rewriting cached history', async () => {
  await activate()
  await savePersonaFile({ name: 'USER.md', content: 'Prefers concise answers.', revision: null })
  await setPersonaAutomatic(false)
  const run = runtime()
  run.session.appendMessage({ role: 'user', content: 'Existing conversation', timestamp: 1 })
  const start = async () => await run('before_agent_start', {
    messageType: 'custom', message: {},
  }) as BeforeAgentStartEventResult & { persona?: string }
  const first = await start()
  expect(first.systemPrompt).toBeUndefined()
  expect(first.persona).toContain('A helpful familiar.')
  expect(first.persona).toContain('Prefers concise answers.')
  expect(first.persona).not.toContain('## Your Current Emotion')
  expect(first.message?.customType).toBe('persona-mood')
  expect(first.message?.display).toBe(false)
  expect(first.message?.content).not.toContain('%')
  const prefix = run.session.buildSessionProjection().messages
  const visibleToModel = convertToLlm(prefix)
  expect(visibleToModel.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: first.message!.content }] })

  await setPersonaEmotion('joy', 0.2)
  const unchanged = await start()
  expect(unchanged.persona).toBe(first.persona)
  expect(unchanged.message).toBeUndefined()
  expect(run.session.buildSessionProjection().messages).toEqual(prefix)

  await setPersonaEmotion('joy', 0.9)
  const stronger = await start()
  expect(stronger.message?.content).not.toBe(first.message?.content)
  expect(stronger.persona).toBe(first.persona)
  await setPersonaEmotion('anger', 0.9)
  const different = await start()
  expect(different.message?.content).not.toBe(stronger.message?.content)
  expect(different.persona).toBe(first.persona)
  const otherSession = await runtime()('before_agent_start', {
    messageType: 'custom', message: {},
  }) as BeforeAgentStartEventResult & { persona?: string }
  expect(otherSession.message?.content).toBe(different.message?.content)
  expect(run.session.buildSessionProjection().messages.slice(0, prefix.length)).toEqual(prefix)
  expect((await start()).message).toBeUndefined()
})

test('IDENTIFY name and description replace the default identity line', async () => {
  await activate()
  const start = async () => await runtime()('before_agent_start', { messageType: 'custom', message: {} }) as { preamble?: string }
  expect((await start()).preamble).toBeUndefined()
  const identify = (await getPersona()).files.find(file => file.name === 'IDENTIFY.md')!
  await savePersonaFile({ ...identify, content: '---\nname: Susan\n---\n' })
  expect((await start()).preamble).toBe('You are Susan.')
  const named = (await getPersona()).files.find(file => file.name === 'IDENTIFY.md')!
  await savePersonaFile({ ...named, content: '---\nname: Susan\ndescription: A loyal familiar.\n---\n' })
  expect((await start()).preamble).toBe('You are Susan. A loyal familiar.')
})

test('snapshot deduplication follows restored branches, compaction and context edits', async () => {
  await activate()
  await setPersonaAutomatic(false)
  const run = runtime()
  const start = async (target = run) => await target('before_agent_start', {
    messageType: 'custom', message: {},
  }) as BeforeAgentStartEventResult & { persona?: string }
  const base = run.session.appendMessage({ role: 'user', content: 'Hello', timestamp: 1 })
  const first = await start()
  const moodId = run.session.getLeafId()!
  expect((await start(runtime(run.session))).message).toBeUndefined()

  await setPersonaEmotion('anger', 0.9)
  const angry = await start()
  const angryId = run.session.getLeafId()!
  run.session.branch(moodId)
  expect((await start()).message?.content).toBe(angry.message?.content)
  run.session.branch(angryId)
  expect((await start()).message).toBeUndefined()
  run.session.branch(base)
  expect((await start()).message?.content).toBe(angry.message?.content)

  const kept = run.session.appendMessage({ role: 'user', content: 'Next', timestamp: 2 })
  run.session.appendCompaction('Summary of earlier discussion', kept, 1000)
  expect((await start()).message?.content).toBe(angry.message?.content)
  expect((await start()).message).toBeUndefined()
  run.session.appendContextEdit(run.session.getLeafId()!, null)
  expect((await start()).message?.content).toBe(angry.message?.content)

  expect(first.message?.content).not.toBe(angry.message?.content)
  const disabledSoul = (await getPersona()).files.find(file => file.name === 'SOUL.md')!
  await savePersonaFile({ ...disabledSoul, content: '' })
  expect(await start()).toBeUndefined()
})

test('compaction recovery queues a missing snapshot without waiting for a new user prompt', async () => {
  await activate()
  await setPersonaAutomatic(false)
  const run = runtime()
  await run('before_agent_start', { messageType: 'custom', message: {} })
  const kept = run.session.appendMessage({ role: 'user', content: 'Recover this request', timestamp: 1 })
  run.session.appendCompaction('Summary', kept, 1000)

  await run('session_compact', { reason: 'threshold', willRetry: false })
  expect(run.sent).toHaveLength(0)
  await run('session_compact', { reason: 'overflow', willRetry: true })
  expect(run.sent).toHaveLength(1)
  const { message, options } = run.sent[0]
  expect(options).toEqual({ deliverAs: 'steer' })
  expect(message).toMatchObject({ customType: 'persona-mood', display: false })
  // The SDK consumes the steer queue before the existing recovery request.
  run.session.appendCustomMessageEntry(message.customType, message.content, message.display)
  await run('session_compact', { reason: 'overflow', willRetry: true })
  expect(run.sent).toHaveLength(1)

  const next = run.session.appendMessage({ role: 'user', content: 'Queued follow-up', timestamp: 2 })
  run.session.appendCompaction('New summary', next, 1000)
  run.queued.pending = true
  await run('session_compact', { reason: 'threshold', willRetry: false })
  expect(run.sent).toHaveLength(2)
  expect(run.sent[1]).toEqual({ message, options })
})

test('session runtimes share one mood, custom runs inject but never consume pending acceptance', async () => {
  await activate()
  const first = runtime()
  const second = runtime()
  await first('session_start')
  await second('session_start')
  await first('agent_start')
  await first('agent_end', { messages: [{ role: 'user', content: 'Add a feature' }] })
  const before = (await getPersona()).mood.history.filter(entry => entry.trigger === 'implicit_acceptance').length
  const injected = await first('before_agent_start', { messageType: 'custom', message: {} }) as { persona: string }
  expect(injected.persona).toContain('A helpful familiar.')
  expect((await getPersona()).mood.history.filter(entry => entry.trigger === 'implicit_acceptance')).toHaveLength(before)
  await first('before_agent_start', { messageType: 'user', prompt: 'Add another feature' })
  expect((await getPersona()).mood.history.filter(entry => entry.trigger === 'implicit_acceptance')).toHaveLength(before + 1)
  await second('tool_result', { toolName: 'bash', input: { command: 'bun test' }, details: {}, structuredContent: { exit_code: 1 }, isError: true })
  expect((await getPersona()).mood.history.at(-1)!.trigger).toBe('test_fail')
  for (const [command, trigger] of [['bun test', 'test_pass'], ['bun run build', 'build_success'], ['pwd', 'command_success']]) {
    await first('tool_result', { toolName: 'bash', input: { command }, details: {}, structuredContent: { exit_code: 0 }, isError: false })
    expect((await getPersona()).mood.history.at(-1)!.trigger).toBe(trigger)
  }
  await setPersonaAutomatic(false)
  const fixed = (await getPersona()).mood
  await first('tool_result', { toolName: 'bash', input: { command: 'bun build' }, details: {}, structuredContent: { exit_code: 0 } })
  expect((await getPersona()).mood.intensity).toBe(fixed.intensity)
  expect((await getPersona()).mood.history).toEqual(fixed.history)
  expect((await getPersona()).files.map(file => file.name)).toEqual([...PERSONA_FILES])
})

test('reads and an inactive persona never take the lock or write mood state', async () => {
  const dir = join(process.env.PIG_DIR!, 'persona')
  await getPersona()
  const run = runtime()
  await run('session_start')
  await run('before_agent_start', { messageType: 'user', prompt: 'hi' })
  await run('tool_result', { toolName: 'bash', input: { command: 'bun test' }, structuredContent: { exit_code: 1 }, isError: true, details: {} })
  await run('agent_end', { messages: [{ role: 'user', content: 'thanks', timestamp: 1 }] })
  await expect(stat(join(dir, 'mood-state.json'))).rejects.toThrow()
  await expect(stat(join(dir, 'mood-state.lock'))).rejects.toThrow()
  await activate()
  await setPersonaAutomatic(false)
  const file = join(dir, 'mood-state.json')
  const before = await readFile(file, 'utf8')
  await run('tool_result', { toolName: 'bash', input: { command: 'bun test' }, structuredContent: { exit_code: 1 }, isError: true, details: {} })
  await getPersona()
  expect(await readFile(file, 'utf8')).toBe(before)
})

test('abandoned ownerless locks and recovery directories are reclaimed once stale', async () => {
  const dir = join(process.env.PIG_DIR!, 'persona')
  const old = new Date(Date.now() - 60_000)
  for (const name of ['mood-state.lock', 'mood-state.lock.recovery']) {
    await mkdir(join(dir, name), { recursive: true })
    await utimes(join(dir, name), old, old)
  }
  expect((await setPersonaEmotion('trust', 0.5)).mood.emotion).toBe('trust')
  await expect(stat(join(dir, 'mood-state.lock.recovery'))).rejects.toThrow()
  await mkdir(join(dir, 'mood-state.lock'))
  await expect(setPersonaEmotion('joy', 0.5)).rejects.toThrow('Timed out')
}, 10_000)

test('a failed lock release keeps the operation error', async () => {
  const lock = join(process.env.PIG_DIR!, 'persona', 'mood-state.lock')
  const failure = await withPersonaLock(async () => {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'other', createdAt: 1 }))
    throw new Error('operation failed')
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors.map(error => (error as Error).message))
    .toEqual(['operation failed', 'Persona lock ownership changed'])
})
