import { mock, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess'

async function fixture(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'pig-learning-queue-')); process.env.PIG_DIR = join(root, 'pig')
  try {
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ passive: false, longTerm: { enabled: true } }) }))
    const service = await import('../src/main/features/memory/long-term/service')
    const { MemoryReviewError } = await import('../src/main/features/memory/long-term/review-errors')
    const release = Promise.withResolvers<void>()
    let calls = 0
    let aborted = false
    mock.module('../src/main/features/memory/long-term/service', () => ({ ...service, LEARNING_IDLE_MS: 5,
      learningStep: async (_ctx: unknown, _settings: unknown, _access: unknown, _ids: unknown, signal: AbortSignal) => {
        calls++
        if (scenario === 'shared') throw new MemoryReviewError('authentication')
        if (['cancel', 'fast-settle', 'shutdown'].includes(scenario) && calls === 1) {
          try { await service.abortable(release.promise, signal) } catch (error) { aborted = true; throw error }
        }
        return { delay: calls < 3 ? 0 : undefined }
      },
    }))
    const { registerLongTermMemory } = await import('../src/main/features/memory/long-term/extension')
    const { Runtime } = await import('../src/main/features/memory/runtime')
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
    const pi = { on: (name: string, fn: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, fn), registerTool: () => {} } as unknown as ExtensionAPI
    let branchReads = 0
    const ctx = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf', getBranch: () => { branchReads++; return [] } } } as unknown as ExtensionContext
    registerLongTermMemory(pi, new Runtime())
    const emit = (event: string) => handlers.get(event)!({}, ctx)
    const wait = async (condition: () => boolean) => {
      const start = Date.now()
      while (!condition()) { if (Date.now() - start > 1500) throw new Error('Timed out ' + scenario); await new Promise(resolve => setTimeout(resolve, 2)) }
    }
    emit('session_start')
    expect(calls).toBe(0)
    await wait(() => calls >= 1)
    if (scenario === 'shared') {
      for (let index = 0; index < 3; index++) { emit('agent_settled'); await new Promise(resolve => setTimeout(resolve, 10)) }
      expect(calls).toBe(1)
    } else if (['cancel', 'fast-settle', 'shutdown'].includes(scenario)) {
      emit(scenario === 'shutdown' ? 'session_shutdown' : 'agent_start')
      if (scenario === 'fast-settle') emit('agent_settled')
      await wait(() => aborted)
      release.resolve()
      if (scenario === 'fast-settle') await wait(() => calls === 3)
      else { await new Promise(resolve => setTimeout(resolve, 20)); expect(calls).toBe(1) }
    } else {
      await wait(() => calls === 3)
      expect(branchReads).toBe(1)
    }
    emit('session_shutdown'); release.resolve()
  } finally { delete process.env.PIG_DIR; rmSync(root, { recursive: true, force: true }) }
}
if (process.argv.includes('--fixture')) await fixture(process.argv[3]!)
else for (const scenario of ['drain', 'shared', 'cancel', 'fast-settle', 'shutdown']) test(`learning queue: ${scenario}`, async () => {
  const { exitCode, stderr, stdout } = await runSelf(import.meta.path, ['--fixture', scenario], { timeoutMs: 10_000 })
  expect(exitCode, stderr || stdout).toBe(0)
}, 15_000)
