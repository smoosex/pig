import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PERSONA_FILES } from '../src/shared/persona'
import { getPersona, savePersonaFile, setPersonaAutomatic, setPersonaMood, setPersonaObserver } from '../src/main/plugins/pi-persona/service'
import { personaTransaction, setActivity } from '../src/main/plugins/pi-persona/kernel'
import { withPersonaLock } from '../src/main/plugins/pi-persona/storage'

let root: string
let oldPig: string | undefined
const values = { pleasantness: -0.8, activation: 0.9, energy: 0.4 }
const statePath = () => join(process.env.PIG_DIR!, 'persona/mood-state.json')
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
async function activate() {
  await savePersonaFile({ name: 'SOUL.md', content: 'A helpful familiar.', revision: null })
}

test('defaults and reads never create state or acquire locks; file revisions and permissions remain private', async () => {
  const initial = await getPersona()
  expect(initial.active).toBe(false)
  expect(initial.files.map(file => file.name)).toEqual([...PERSONA_FILES])
  expect(initial.mood).toMatchObject({ pleasantness: 0.15, activation: 0.35, energy: 0.75, automatic: true, observer: { enabled: true } })
  await setActivity('inactive', true)
  await setActivity('missing', false)
  await expect(stat(statePath())).rejects.toThrow()
  await expect(stat(join(process.env.PIG_DIR!, 'persona/mood-state.lock'))).rejects.toThrow()
  await activate()
  const soul = (await getPersona()).files.find(file => file.name === 'SOUL.md')!
  expect(soul.revision).toMatch(/^[a-f0-9]{64}$/)
  expect((await stat(join(process.env.PIG_DIR!, 'persona'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(process.env.PIG_DIR!, 'persona/SOUL.md'))).mode & 0o777).toBe(0o600)
  expect((await savePersonaFile({ ...soul, content: '' })).active).toBe(false)
  await expect(savePersonaFile({ ...soul, content: 'stale' })).rejects.toThrow('conflict')
})

test('strict document validation rejects malformed YAML, executable engines, invalid traits and size', async () => {
  for (const content of ['---\nname: [broken\n---', '---\nname: test', '---\nname: 42\n---', '---\nsarcasm: 2\n---', '\uFEFF---javascript\n({name: "x"})\n---']) {
    await expect(savePersonaFile({ name: 'IDENTIFY.md', content, revision: null })).rejects.toThrow()
  }
  await expect(savePersonaFile({ name: '../SOUL.md', content: 'x', revision: null } as never)).rejects.toThrow('Invalid')
  await expect(savePersonaFile({ name: 'USER.md', content: 'a'.repeat(256 * 1024 + 1), revision: null })).rejects.toThrow('256 KiB')
})

test('manual mood works when automatic is off, frozen reads never write, history stays bounded', async () => {
  await setPersonaAutomatic(false)
  await setPersonaMood(values)
  const disk = JSON.parse(await readFile(statePath(), 'utf8'))
  disk.lastInteraction -= 86400000
  await writeFile(statePath(), JSON.stringify(disk))
  const before = await readFile(statePath(), 'utf8')
  expect((await getPersona()).mood).toMatchObject(values)
  expect(await readFile(statePath(), 'utf8')).toBe(before)
  await Promise.all(Array.from({ length: 8 }, () => setPersonaMood(values)))
  for (let i = 0; i < 45; i++) await setPersonaMood(values)
  expect((await getPersona()).mood.history).toHaveLength(50)
  expect((await setPersonaAutomatic(true)).mood).toMatchObject(values)
  expect((await stat(statePath())).mode & 0o777).toBe(0o600)
  await expect(setPersonaMood({ ...values, energy: NaN })).rejects.toThrow()
  await expect(setPersonaMood({ ...values, pleasantness: 2 })).rejects.toThrow()
})

test('observer persists globally, omitted model inherits, paired model IDs are required', async () => {
  await setPersonaObserver({ enabled: false, provider: 'test', modelId: 'observer' })
  expect((await getPersona()).mood.observer).toEqual({ enabled: false, provider: 'test', modelId: 'observer' })
  await setPersonaObserver({ enabled: true, provider: 'test', modelId: 'observer', thinking: 'off' })
  expect((await getPersona()).mood.observer.thinking).toBe('off')
  await setPersonaObserver({ enabled: true, provider: 'test', modelId: 'observer', thinking: 'high' })
  expect((await getPersona()).mood.observer.thinking).toBe('high')
  await expect(setPersonaObserver({ enabled: true, thinking: 'high' })).rejects.toThrow()
  await expect(setPersonaObserver({ enabled: true, provider: 'test', modelId: 'observer', thinking: 'invalid' as never })).rejects.toThrow()
  await setPersonaObserver({ enabled: true })
  expect((await getPersona()).mood.observer).toEqual({ enabled: true })
  await expect(setPersonaObserver({ enabled: true, provider: 'test' })).rejects.toThrow()
  await expect(setPersonaObserver({ enabled: true, provider: '', modelId: '' })).rejects.toThrow()
})

test('independent processes serialize global history under the disk lock', async () => {
  const service = new URL('../src/main/plugins/pi-persona/service.ts', import.meta.url).pathname
  const script = `import { setPersonaMood } from ${JSON.stringify(service)}; for (let i = 0; i < 4; i++) await setPersonaMood(${JSON.stringify(values)});`
  const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, PIG_DIR: process.env.PIG_DIR! }, stdout: 'pipe', stderr: 'pipe',
  }))
  for (const child of children) {
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
  }
  expect((await getPersona()).mood.history).toHaveLength(8)
  expect(JSON.parse(await readFile(statePath(), 'utf8')).nextHistorySequence).toBe(9)
})

function legacyState() {
  return { version: 2, lastInteraction: Date.now(), lastAngle: 270, lastIntensity: 0.8,
    emotionUpdatesEnabled: false, nextHistorySequence: 2, history: [{ id: 'old', sessionId: 'global', sequence: 1,
      angle: 270, intensity: 0.8, emotion: 'anger', level: 3, timestamp: 1, trigger: 'manual_set' }] }
}

test('v2 migration preserves negative valence, automatic, sequence and history; only a later change writes v3', async () => {
  await activate()
  const raw = JSON.stringify(legacyState())
  await writeFile(statePath(), raw)
  const migrated = await getPersona()
  expect(migrated.mood.pleasantness).toBeLessThan(0)
  expect(migrated.mood.activation).toBeGreaterThan(0.35)
  expect(migrated.mood.automatic).toBe(false)
  expect(migrated.mood.observer).toEqual({ enabled: true })
  expect(migrated.mood.history[0].trigger).toBe('manual_set')
  expect(await readFile(statePath(), 'utf8')).toBe(raw)
  await setPersonaObserver({ enabled: false })
  const disk = JSON.parse(await readFile(statePath(), 'utf8'))
  expect(disk.version).toBe(3)
  expect(disk.nextHistorySequence).toBe(2)
  expect(disk.history[0].id).toBe('old')
})

test('legacy state and every history entry are validated before migration, not silently truncated', async () => {
  await activate()
  for (const corrupt of [
    { ...legacyState(), lastAngle: -1 },
    { ...legacyState(), emotionUpdatesEnabled: 'false' },
    { ...legacyState(), lastLateNightTrigger: -1 },
    { ...legacyState(), nextHistorySequence: 1 },
    { ...legacyState(), history: [{ ...legacyState().history[0], emotion: 'unknown' }] },
    { ...legacyState(), history: [{ ...legacyState().history[0], intensity: 2 }] },
  ]) {
    const raw = JSON.stringify(corrupt)
    await writeFile(statePath(), raw)
    await expect(getPersona()).rejects.toThrow()
    await expect(setPersonaMood(values)).rejects.toThrow()
    expect(await readFile(statePath(), 'utf8')).toBe(raw)
  }
})

test('corrupt v3 state, observer, activity, JSON and I/O are never replaced by defaults', async () => {
  await setPersonaMood(values)
  const valid = JSON.parse(await readFile(statePath(), 'utf8'))
  for (const corrupt of [ { ...valid, energy: 4 }, { ...valid, feeling: 42 },
    { ...valid, observer: { enabled: true, modelId: 'one-sided' } }, { ...valid, activeSessions: { bad: 'time' } },
    { ...valid, history: [{ ...valid.history[0], pleasantness: -2 }] }, { ...valid, version: 4 } ]) {
    const raw = JSON.stringify(corrupt)
    await writeFile(statePath(), raw)
    await expect(getPersona()).rejects.toThrow()
    await expect(setPersonaMood(values)).rejects.toThrow()
    expect(await readFile(statePath(), 'utf8')).toBe(raw)
  }
  await writeFile(statePath(), '{broken')
  await expect(getPersona()).rejects.toThrow()
  await rm(statePath())
  await mkdir(join(process.env.PIG_DIR!, 'persona/USER.md'))
  await expect(getPersona()).rejects.toThrow()
})

test('activity is global and transactionally persisted; automatic off still permits lifecycle cleanup', async () => {
  await activate()
  await setPersonaAutomatic(false)
  await setActivity('one', true)
  await setActivity('two', true)
  await setActivity('one', false)
  expect(Object.keys(JSON.parse(await readFile(statePath(), 'utf8')).activeSessions)).toEqual(['two'])
  await setActivity('two', false)
  expect(JSON.parse(await readFile(statePath(), 'utf8')).activeSessions).toEqual({})
  await personaTransaction(transaction => {
    transaction.engine.setMood({ ...values, feeling: 'private observation' }, 'observation')
    transaction.appendHistory()
  })
  expect((await getPersona()).mood.history.at(-1)?.feeling).toBe('private observation')
})

test('stale ownerless locks are reclaimed, live ownerless locks time out', async () => {
  const dir = join(process.env.PIG_DIR!, 'persona')
  const old = new Date(Date.now() - 60000)
  for (const name of ['mood-state.lock', 'mood-state.lock.recovery']) {
    await mkdir(join(dir, name), { recursive: true })
    await utimes(join(dir, name), old, old)
  }
  expect((await setPersonaMood(values)).mood).toMatchObject(values)
  await mkdir(join(dir, 'mood-state.lock'))
  await expect(setPersonaMood(values)).rejects.toThrow('Timed out')
}, 10000)

test('a failed lock release retains the original operation error', async () => {
  const lock = join(process.env.PIG_DIR!, 'persona/mood-state.lock')
  const failure = await withPersonaLock(async () => {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'other', createdAt: 1 }))
    throw new Error('operation failed')
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors.map(error => (error as Error).message)).toEqual(['operation failed', 'Persona lock ownership changed'])
})
