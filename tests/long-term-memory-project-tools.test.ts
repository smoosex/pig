import { mock, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pig-project-memory-')); process.env.PIG_DIR = join(root, 'pig')
  try {
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ passive: true, longTerm: { enabled: true } }) }))
    const { LongTermMemoryStore } = await import('../src/main/features/memory/long-term/store')
    const { longTermMemoryPath } = await import('../src/main/features/memory/paths')
    const { seedKnowledge, rawWindow } = await import('./helpers/long-term-memory')
    const { registerLongTermMemory } = await import('../src/main/features/memory/long-term/extension')
    const { Runtime } = await import('../src/main/features/memory/runtime')
    const store = new LongTermMemoryStore(longTermMemoryPath())
    const profile = seedKnowledge(store, rawWindow(root), ['用户参与过 Atlas CLI 的开发'], 'project')[0]!
    const fact = seedKnowledge(store, rawWindow(root, 2), ['Atlas 项目采用中文检索'])[0]!
    store.close()
    const other = join(root, 'other'); mkdirSync(other)
    const ctx = { cwd: other, sessionManager: { getSessionId: () => 'other-session' } } as unknown as ExtensionContext
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>()
    registerLongTermMemory({ on: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, new Runtime())
    const call = async (name: string, args: unknown) => {
      const result = await tools.get(name)!.execute('call', args, new AbortController().signal, undefined, ctx)
      return result.content[0].text as string
    }
    expect(await call('memory_projects', {})).toContain(profile.id)
    expect(await call('memory_search', { query: '中文检索', kind: 'knowledge' })).not.toContain(fact.id)
    expect(await call('memory_search', { query: '中文检索', kind: 'knowledge', projectId: profile.id })).toContain(fact.id)
    expect(await call('memory_search', { query: '中文检索', kind: 'episodes', projectId: profile.id })).toContain('实现中文检索')
    await expect(call('memory_read', { id: fact.id })).rejects.toThrow(/current scope/)
    expect(await call('memory_read', { id: fact.id, projectId: profile.id })).toContain(fact.content)
    await expect(call('memory_read', { id: fact.id, projectId: fact.id })).rejects.toThrow(/profile/)
    await expect(call('memory_search', { query: '中文', projectId: 'f'.repeat(64) })).rejects.toThrow(/profile/)
  } finally { delete process.env.PIG_DIR; rmSync(root, { recursive: true, force: true }) }
}
if (process.argv.includes('--fixture')) await fixture()
else test('projects are discoverable without exposing details; targeted knowledge/experience reads require a real project profile boundary', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  expect(exitCode, stderr || stdout).toBe(0)
}, 15_000)
