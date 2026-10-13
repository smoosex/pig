import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import type { AgentSession } from '@earendil-works/pi-coding-agent'

const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))

async function fixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const calls: Array<string | undefined> = []
  let compactionFails = false
  let preparationFails = false
  const preparationError = new Error('Session unavailable')

  mock.module('electron', () => ({
    dialog: {},
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)
    }
  }))
  mock.module(modulePath('../src/main/i18n.ts'), () => ({ t: (key: string) => key }))
  mock.module(modulePath('../src/main/pi/session-registry.ts'), () => ({
    ...Object.fromEntries([
      'activateSession', 'activateSessionInput', 'closeSession', 'createPendingSession', 'discardDraftSession', 'exportSession',
      'forkSessionFromMessage', 'getSessionControls', 'getSessionTokenStats', 'getSessionTrees', 'listSessionCommands', 'openSession',
      'promoteDraftSession', 'renameSession', 'setSessionLabel', 'setSessionModel',
      'setSessionThinking', 'updateFollowUpMessage', 'viewSessionBranch'
    ].map((name) => [name, () => {}])),
    prepareSession: async (sessionId: string) => {
      assert.equal(sessionId, 'session')
      if (preparationFails) throw preparationError
      return {
        agentSession: {
          isStreaming: true,
          compact: async (instructions?: string) => {
            calls.push(instructions)
            if (compactionFails) throw new Error('Nothing to compact (session too small)')
          }
        }
      }
    }
  }))
  mock.module(modulePath('../src/main/pi/session-display.ts'), () => ({
    getDisplayTurns: () => {}, getTurnMessages: () => {}, getTurnWindow: () => {}
  }))
  mock.module(modulePath('../src/main/pi/session-loader.ts'), () => ({
    removeSessionFile: () => {},
    sessionDirForCwd: () => '/sessions'
  }))
  mock.module(modulePath('../src/main/pi/session-prompt.ts'), () => ({ promptSession: () => {} }))
  mock.module(modulePath('../src/main/chats.ts'), () => ({
    createChatDir: async () => '/chat',
    isChatCwd: () => false,
    isChatsRoot: () => false
  }))
  mock.module(modulePath('../src/main/open-project-sessions.ts'), () => ({
    forgetOpenProjectSession: () => {}, rememberOpenProjectSession: () => {}
  }))
  mock.module(modulePath('../src/main/ipc/window.ts'), () => ({ windowForEvent: () => ({}) }))
  mock.module(modulePath('../src/main/pi/event-bridge.ts'), () => ({
    batchQueueUpdates: () => {}, queuedUserImages: () => [],
    removePendingUserMessage: () => {}, updatePendingUserMessageMode: () => {}
  }))

  const { registerSessionIpc } = await import('../src/main/ipc/session')
  registerSessionIpc()
  const compact = handlers.get('session:compact')
  assert.ok(compact)
  await compact({}, 'session')
  await compact({}, 'session', '  Preserve decisions  ')
  assert.deepEqual(calls, [undefined, 'Preserve decisions'])
  compactionFails = true
  await compact({}, 'session')
  assert.equal(calls.length, 3)
  preparationFails = true
  await assert.rejects(Promise.resolve().then(() => compact({}, 'session')), (error) => error === preparationError)
  assert.equal(calls.length, 3)

  const { listSessionCommands } = await import('../src/main/pi/session-actions')
  const session = {
    extensionRunner: { getRegisteredCommands: () => [{ invocationName: 'review', description: 'Review changes' }] },
    promptTemplates: [{ name: 'explain', description: 'Explain code' }],
    resourceLoader: { getSkills: () => ({ skills: [{ name: 'test', description: 'Write tests' }] }) }
  } as unknown as AgentSession
  assert.deepEqual(await listSessionCommands(session), [
    { name: 'compact', source: 'builtin' },
    { name: 'review', description: 'Review changes', source: 'extension' },
    { name: 'explain', description: 'Explain code', source: 'prompt' },
    { name: 'skill:test', description: 'Write tests', source: 'skill' }
  ])
}

if (process.argv[2] === '--compact-fixture') {
  await fixture()
} else {
  test('native compact IPC runs during streaming, reports failures through events, and is advertised as a builtin', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--compact-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}
