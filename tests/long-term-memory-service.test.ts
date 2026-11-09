import { mock, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess'

async function fixture(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'pig-learning-step-')); process.env.PIG_DIR = join(root, 'pig')
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { parseLearning } = await import('../src/main/features/memory/long-term/learning')
    const { learningOutput } = await import('./helpers/long-term-memory')
    const { parseIntegration } = await import('../src/main/features/memory/long-term/integration')
    let enabled = true
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ passive: false, longTerm: { enabled } }) }))
    const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    let calls = 0
    const learning = await import('../src/main/features/memory/long-term/learning')
    mock.module('../src/main/features/memory/long-term/learning', () => ({ ...learning,
      extractLearning: async (_ctx: unknown, _settings: unknown, window: Parameters<typeof parseLearning>[1], prior: Parameters<typeof parseLearning>[2]) => {
        calls++; started.resolve()
        if (['rename', 'branch', 'cancel', 'disable', 'forget'].includes(scenario)) await release.promise
        return parseLearning(JSON.stringify(scenario === 'no-op' ? { episodes: [] } : learningOutput(window)), window, prior)
      },
    }))
    const integration = await import('../src/main/features/memory/long-term/integration')
    mock.module('../src/main/features/memory/long-term/integration', () => ({ ...integration,
      integrateKnowledge: async (_ctx: unknown, _settings: unknown, input: Parameters<typeof parseIntegration>[1], existing: Parameters<typeof parseIntegration>[2], access: Parameters<typeof parseIntegration>[3]) =>
        parseIntegration(JSON.stringify({ changes: input.proposals.map(p => ({ proposalId: p.id, action: 'add', content: p.content, applicability: p.applicability })) }), input, existing, access),
    }))
    const { learningStep, withMemoryStore } = await import('../src/main/features/memory/long-term/service')
    const manager = SessionManager.create(root, join(root, 'sessions'))
    const user = manager.appendMessage({ role: 'user', content: '项目使用中文检索', timestamp: Date.now() })
    manager.appendCustomEntry('test.flush', {})
    expect(existsSync(manager.getSessionFile()!)).toBe(true)
    const ctx = { cwd: root, sessionManager: manager, isIdle: () => true } as unknown as ExtensionContext
    const { memoryAccess } = await import('../src/main/features/memory/long-term/access')
    const access = await memoryAccess(ctx)
    const ids = () => new Set(manager.getBranch().map(e => e.id))
    const controller = new AbortController()
    const pending = learningStep(ctx, { enabled }, access, ids(), controller.signal)
    if (['rename', 'branch', 'cancel', 'disable', 'forget'].includes(scenario)) {
      await started.promise
      if (scenario === 'rename') manager.appendSessionInfo('renamed without idle event')
      if (scenario === 'branch') manager.branch(user)
      if (scenario === 'cancel') controller.abort(new Error('cancelled'))
      if (scenario === 'disable') enabled = false
      if (scenario === 'forget') withMemoryStore(store => store.forgetFact('a'.repeat(64)))
      release.resolve()
    }
    if (['branch', 'cancel', 'disable', 'forget'].includes(scenario)) {
      await expect(pending).rejects.toThrow()
      expect(withMemoryStore(store => store.processed(access.session, user))).toBe(false)
    } else {
      await pending
      expect(withMemoryStore(store => store.processed(access.session, user))).toBe(true)
      if (scenario !== 'no-op') {
        await learningStep(ctx, { enabled }, access, ids(), new AbortController().signal)
        expect(withMemoryStore(store => store.search('中文', access))).toHaveLength(1)
      }
      if (scenario === 'rename') await learningStep(ctx, { enabled }, access, ids(), new AbortController().signal)
      const restored = SessionManager.open(manager.getSessionFile()!)
      const reopened = { ...ctx, sessionManager: restored } as ExtensionContext
      await learningStep(reopened, { enabled }, access, new Set(restored.getBranch().map(e => e.id)), new AbortController().signal)
      expect(calls).toBe(1)
      if (scenario === 'no-op') expect(withMemoryStore(store => store.page('episodes').episodes)).toEqual([])
    }
  } finally { delete process.env.PIG_DIR; rmSync(root, { recursive: true, force: true }) }
}
if (process.argv.includes('--fixture')) await fixture(process.argv[3]!)
else for (const scenario of ['success', 'no-op', 'rename', 'branch', 'cancel', 'disable', 'forget']) test(`raw learning atomic lifecycle: ${scenario}`, async () => {
  const { exitCode, stderr, stdout } = await runSelf(import.meta.path, ['--fixture', scenario], { timeoutMs: 10_000 })
  expect(exitCode, stderr || stdout).toBe(0)
}, 15_000)
