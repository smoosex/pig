import { mock, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pig-learning-slots-')); process.env.PIG_DIR = join(root, 'pig')
  try {
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ passive: false, longTerm: { enabled: true } }) }))
    const learning = await import('../src/main/features/memory/long-term/learning')
    const release = Promise.withResolvers<void>()
    const twoStarted = Promise.withResolvers<void>()
    let calls = 0
    mock.module('../src/main/features/memory/long-term/learning', () => ({ ...learning, extractLearning: async () => {
      calls++; if (calls === 2) twoStarted.resolve()
      await release.promise
      return { episodes: [], proposals: [] }
    } }))
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { learningStep, learningConcurrency, withMemoryStore } = await import('../src/main/features/memory/long-term/service')
    const { memoryAccess } = await import('../src/main/features/memory/long-term/access')
    const contexts = Array.from({ length: 3 }, () => {
      const sessionManager = SessionManager.create(root, join(root, 'sessions'))
      sessionManager.appendMessage({ role: 'user', content: '以后默认用 Bun', timestamp: Date.now() })
      sessionManager.appendCustomEntry('test.flush', {})
      return { cwd: root, sessionManager, isIdle: () => true } as unknown as ExtensionContext
    })
    const signals = contexts.map(() => new AbortController())
    const jobs = await Promise.all(contexts.map(async (ctx, index) => ({ ctx, signal: signals[index]!, access: await memoryAccess(ctx) })))
    const pending = jobs.map(({ ctx, access, signal }) => learningStep(ctx, { enabled: true }, access, new Set(ctx.sessionManager.getBranch().map(e => e.id)), signal.signal))
    const settled = Promise.allSettled(pending)
    await twoStarted.promise
    expect(learningConcurrency()).toBe(2)
    expect(calls).toBe(2)
    signals[2]!.abort(new Error('cancel queued worker'))
    release.resolve()
    const result = await settled
    expect(result.map(item => item.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(learningConcurrency()).toBe(0)
    expect(calls).toBe(2)
    for (const { ctx, access } of jobs.slice(0, 2)) expect(withMemoryStore(store => store.processed(access.session, ctx.sessionManager.getLeafId()!))).toBe(true)
  } finally { delete process.env.PIG_DIR; rmSync(root, { recursive: true, force: true }) }
}
if (process.argv.includes('--fixture')) await fixture()
else test('global learning limit is two; queued cancellation releases cleanly and independent extractions do not invalidate each other', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  expect(exitCode, stderr || stdout).toBe(0)
}, 15_000)
