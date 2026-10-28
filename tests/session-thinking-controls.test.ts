/**
 * The thinking levels an unbuilt session offers and the levels it accepts have to come from the same
 * resolved model: the one the branch recorded, never the global default. A session opened from a file
 * whose model supports thinking must accept the level its own picker shows.
 *
 * The SDK is mocked here, so both scenarios run in a child process, like the other main-process
 * fixtures: a `mock.module` registered in this process would answer every later import of the SDK.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorktreeService } from '../src/main/worktrees'

const stamp = '2026-01-01T00:00:00.000Z'
const MODELS = [
  { id: 'recorder', provider: 'recorder', name: 'Recorder', contextWindow: 1000, reasoning: true },
  { id: 'plain', provider: 'plain', name: 'Plain', contextWindow: 1000, reasoning: false }
]

function historyLines(sessionId: string, cwd: string, provider: string) {
  return [
    { type: 'session', version: 3, id: sessionId, cwd, timestamp: stamp },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: stamp, provider, modelId: provider },
    {
      type: 'message',
      id: 'u1',
      parentId: 'm1',
      timestamp: stamp,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 }
    }
  ]
}

async function fixture(scenario: string): Promise<void> {
  const recorded = scenario === 'recorded-reasoning' ? MODELS[0]! : MODELS[1]!
  // The global default always sits on the other side, so only the session's own model can answer.
  const fallback = recorded.reasoning ? MODELS[1]! : MODELS[0]!
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pig-thinking-controls-')))
  const service = new WorktreeService(join(cwd, 'state'))
  const sessionId = `history-${scenario}`
  const path = join(cwd, 'history.jsonl')
  const lines = historyLines(sessionId, cwd, recorded.provider)
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

  const thinking: string[] = []
  const manager = {
    getCwd: () => cwd,
    getSessionId: () => sessionId,
    getSessionFile: () => path,
    getHeader: () => lines[0],
    setSessionFile: () => {},
    getEntries: () => [],
    getLeafId: () => 'u1',
    getBranch: () => [],
    buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: 'off' })
  }
  const session = {
    sessionId,
    sessionFile: path,
    sessionManager: manager,
    agent: { streamFunction: () => { throw new Error('Unexpected model request') } },
    bindExtensions: async () => {},
    setModel: async () => {},
    setThinkingLevel: (level: string) => {
      thinking.push(level)
    },
    getAvailableThinkingLevels: () => ['low', 'medium', 'high'],
    subscribe: () => () => {},
    abort: async () => {},
    extensionRunner: { emit: async () => {} },
    dispose: () => {}
  }

  try {
    process.env.PIG_DIR = join(cwd, 'pig')
    mock.module('electron', () => ({
      app: { isPackaged: false, getAppPath: () => process.cwd() },
      BrowserWindow: { getAllWindows: () => [] }
    }))
    mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({
      worktrees: service
    }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      createAgentSession: async () => ({ session }),
      ModelRuntime: {
        create: async () => ({
          refresh: async () => {},
          getModel: (provider: string, id: string) => MODELS.find((model) => model.provider === provider && model.id === id),
          getProvider: () => undefined,
          getAvailableSnapshot: () => MODELS
        })
      },
      SessionManager: { create: () => manager, open: () => manager },
      SettingsManager: {
        fromStorage: sdk.SettingsManager.fromStorage,
        create: () => ({
          getModelThinkingLevel: () => undefined,
          getDefaultThinkingLevel: () => undefined, getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
          getDefaultProvider: () => fallback.provider,
          getDefaultModel: () => fallback.id,
          flush: async () => {}
        })
      },
      DefaultResourceLoader: class {
        async reload() {}
        getExtensions() { return { extensions: [], errors: [] } }
      },
      getAgentDir: () => join(cwd, 'agent')
    }))

    const registry = await import('../src/main/pi/session-registry')
    const win = {
      isDestroyed: () => true,
      webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => {} })
    } as unknown as Parameters<
      typeof registry.openSession
    >[1]

    await registry.openSession(path, win)
    const controls = await registry.getSessionControls(sessionId)
    assert.equal(controls.model?.id, recorded.id, 'an opened session answers for the model its file recorded')

    if (recorded.reasoning) {
      assert.ok(
        controls.thinkingLevels.includes('high'),
        `the picker offers high: ${controls.thinkingLevels.join(',')}`
      )
      const chosen = await registry.setSessionThinking(sessionId, 'high')
      assert.equal(chosen.thinkingLevel, 'high', 'the picker must accept the levels it offers')
      await registry.prepareSession(sessionId)
      assert.deepEqual(thinking, ['high'], 'the level chosen before the first send reaches the built session')
    } else {
      assert.deepEqual(controls.thinkingLevels, [], 'a model without thinking offers no levels')
      await assert.rejects(registry.setSessionThinking(sessionId, 'high'), /not supported/)
      assert.deepEqual(thinking, [], 'a level the session cannot do never reaches the built session')
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--thinking-controls-fixture') {
  await fixture(process.argv[3]!)
} else {
  const scenarios: Record<string, string> = {
    'recorded-reasoning': 'an opened session accepts the thinking levels its recorded model offers',
    'recorded-plain': 'an opened session refuses thinking levels its recorded model cannot do'
  }
  for (const [scenario, name] of Object.entries(scenarios)) {
    test(name, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--thinking-controls-fixture', scenario], {
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 5_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(exitCode, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 10_000)
  }
}
