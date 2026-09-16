/**
 * A session opened from disk stays pending until its first send. Model and thinking level picked in
 * that window have to reach the built session: `createAgentSession` restores the model and thinking
 * level the JSONL recorded whenever the build carries no explicit ones.
 *
 * The SDK is mocked here, so every scenario runs in a child process, like the other main-process
 * fixtures: a `mock.module` registered in this process would answer every later import of the SDK.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorktreeService } from '../src/main/worktrees'

const stamp = '2026-01-01T00:00:00.000Z'

/** A session whose branch recorded `old`/`low`, including the user message that makes it resumable. */
function historyLines(sessionId: string, cwd: string, version: number) {
  return [
    { type: 'session', version, id: sessionId, cwd, timestamp: stamp },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: stamp, provider: 'old', modelId: 'old' },
    { type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: stamp, thinkingLevel: 'low' },
    {
      type: 'message',
      id: 'u1',
      parentId: 't1',
      timestamp: stamp,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 }
    }
  ]
}

async function fixture(version: number): Promise<void> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pig-pending-controls-')))
  const service = new WorktreeService(join(cwd, 'state'))
  const sessionId = `history-v${version}`
  const path = join(cwd, 'history.jsonl')
  const lines = historyLines(sessionId, cwd, version)
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

  const chosen: string[] = []
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
    buildSessionContext: () => ({
      messages: [],
      model: { provider: 'old', modelId: 'old' },
      thinkingLevel: 'low'
    })
  }
  const session = {
    sessionId,
    sessionFile: path,
    sessionManager: manager,
    bindExtensions: async () => {},
    setModel: async (model: { provider: string; id: string }) => {
      chosen.push(`${model.provider}/${model.id}`)
    },
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
      app: { isPackaged: false },
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
          getModel: (provider: string, id: string) => ({
            provider,
            id,
            name: id,
            contextWindow: 1000,
            reasoning: true
          }),
          getProvider: () => undefined,
          getAvailableSnapshot: () => []
        })
      },
      SessionManager: { create: () => manager, open: () => manager },
      SettingsManager: {
        create: () => ({
          getModelThinkingLevel: () => undefined,
          getDefaultThinkingLevel: () => undefined,
          getDefaultProvider: () => undefined,
          getDefaultModel: () => undefined,
          flush: async () => {}
        })
      },
      DefaultResourceLoader: class {
        async reload() {}
      },
      getAgentDir: () => join(cwd, 'agent')
    }))

    const registry = await import('../src/main/pi/session-registry')
    const win = { isDestroyed: () => true, webContents: { send: () => {} } } as unknown as Parameters<
      typeof registry.openSession
    >[1]

    await registry.openSession(path, win)
    await registry.setSessionModel(sessionId, 'new', 'new')
    await registry.setSessionThinking(sessionId, 'high')

    // The choices rest in the pending session, which is all the renderer reads before the first send.
    const pending = await registry.getSessionControls(sessionId)
    assert.equal(pending.model?.id, 'new')
    assert.equal(pending.thinkingLevel, 'high')

    await registry.prepareSession(sessionId)
    assert.deepEqual(chosen, ['new/new'])
    assert.deepEqual(thinking, ['high'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--pending-controls-fixture') {
  await fixture(Number(process.argv[3]))
} else {
  const versions: Record<string, string> = {
    '3': 'a session opened from a current file keeps the model picked before its first send',
    '2': 'a session opened from a file that needs migration keeps the model picked before its first send'
  }
  for (const [version, name] of Object.entries(versions)) {
    test(name, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--pending-controls-fixture', version], {
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
