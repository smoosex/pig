import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { SessionManager, type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { SessionApi, SessionControls } from '../src/shared/api'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-transformed-prompts-'))
  let activeSession: AgentSession
  mock.module('../src/main/pi/session-registry', () => ({
    activateSessionInput: async () => ({ session: { cwd: root, agentSession: activeSession }, releaseInput: () => {} })
  }))
  mock.module('../src/main/project-worktrees', () => ({
    worktrees: { assertAvailable() {}, nameOnFirstPrompt: async () => {} }
  }))
  mock.module('../src/main/pi/branch-namer', () => ({ nameWorktreeBranch() {} }))
  mock.module('../src/main/i18n', () => ({ t: (key: string) => key }))

  const api = {} as SessionApi
  Object.assign(globalThis, { window: { api } })
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { useComposerDraftsStore: drafts } = await import('../src/renderer/src/stores/composer-drafts')
  const { textToComposerDocument } = await import('../src/renderer/src/components/composer/document')
  const { bridgeEvents } = await import('../src/main/pi/event-bridge')
  const { promptSession } = await import('../src/main/pi/session-prompt')
  const { normalizeSessionPrompt } = await import('../src/main/pi/prompt-input')
  const { restoreSessionUserPrompt } = await import('../src/main/pi/session-user-prompt')
  const { switchSessionBranch } = await import('../src/main/pi/session-branch')
  const { forkSessionManager } = await import('../src/main/pi/session-fork')
  const { displayTurnsFromEntries } = await import('../src/main/pi/session-display-model')
  const { isPastedTextMetadata, resolvePastedTextMetadata } = await import('../src/shared/pasted-text')
  const controls: SessionControls = {
    model: null, thinkingLevel: 'off', thinkingLevels: ['off'],
    contextUsage: null, followUpMessages: [], steeringMessages: []
  }
  api.getControls = async () => controls
  api.isChatCwd = async () => false
  api.listProject = async () => null

  try {
    for (const inline of [false, true]) {
      for (const transform of ['hook', 'skill', 'template']) {
        for (const queued of [false, true]) {
          const manager = SessionManager.create(root, join(root, 'source'))
          const first = manager.appendMessage({ role: 'user', content: 'previous turn', timestamp: 1 })
          const attachmentText = '完整附件内容'
          const text = inline ? `/skill:review ${attachmentText}\n继续` : '/review'
          const input = {
            text,
            images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
            textAttachments: [{
              id: 'paste', text: attachmentText, filename: 'notes.txt',
              ...(inline ? { start: '/skill:review '.length, end: '/skill:review '.length + attachmentText.length } : {})
            }],
            ...(queued ? { streamingBehavior: 'followUp' } : {})
          }
          const normalized = normalizeSessionPrompt(input)
          assert.equal(normalized.metadata?.version, inline ? 2 : 1)
          const transformed = transform === 'hook' ? 'The hook replaced the entire prompt'
            : transform === 'skill' ? `<skill>Instructions</skill>\n${normalized.modelText}`
              : `Template prefix\n${normalized.modelText}\nTemplate suffix`
          const listeners = new Set<(event: AgentSessionEvent) => void>()
          const events: AgentSessionEvent[] = []
          const followUp: string[] = []
          const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event) }
          const emitQueue = () => emit({ type: 'queue_update', steering: [], followUp: [...followUp] })
          const message = {
            role: 'user' as const, timestamp: 2,
            content: [
              { type: 'text' as const, text: transformed + '\n\n[Image: original 10x10, displayed at 10x10. Multiply coordinates by 1.00 to map to original image.]' },
              { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' }
            ]
          }
          const session = {
            sessionManager: manager,
            agent: { streamFunction: () => { throw new Error('Unexpected model request') } },
            isStreaming: queued,
            isBashRunning: false,
            extensionRunner: { getCommand: () => undefined, emit: async () => {} },
            refreshContext() {},
            subscribe: (listener: (event: AgentSessionEvent) => void) => {
              listeners.add(listener)
              return () => { listeners.delete(listener) }
            },
            getSteeringMessages: () => [],
            getFollowUpMessages: () => followUp,
            prompt: async (submitted: string) => {
              assert.equal(submitted, normalized.modelText)
              await Promise.resolve()
              if (session.isStreaming) {
                followUp.push(transformed)
                emitQueue()
              } else deliver()
            }
          }
          function deliver() {
            emit({ type: 'message_start', message })
            emit({ type: 'message_end', message })
            session.sessionManager.appendMessage(message)
            session.isStreaming = false
          }
          activeSession = session as unknown as AgentSession
          const unsubscribe = bridgeEvents(activeSession, 'session', {
            isDestroyed: () => false,
            webContents: { isDestroyed: () => false, send: (_channel: string, payload: { event: AgentSessionEvent }) => events.push(payload.event) }
          } as unknown as BrowserWindow)
          try {
            await promptSession('session', input)
            if (queued) {
              assert.deepEqual(manager.getEntries().map((entry) => entry.id), [first], 'queued metadata waits for delivery')
              followUp.shift()
              emitQueue()
              deliver()
            }
            const reopened = SessionManager.open(manager.getSessionFile()!)
            const selected = reopened.getEntries().at(-1)!
            const metadata = reopened.getEntry(selected.parentId!)!
            assert.equal(metadata.type, 'custom')
            if (metadata.type !== 'custom') throw new Error('Missing pasted-text entry')
            assert.ok(isPastedTextMetadata(metadata.data))
            assert.equal(metadata.data.version, 3)
            assert.equal(resolvePastedTextMetadata(transformed, metadata.data).text, normalized.modelText)
            const restored = restoreSessionUserPrompt(reopened, selected)
            assert.equal(restored.parentId, first)
            assert.equal(restored.prompt.text, normalized.modelText)
            assert.deepEqual(restored.prompt.images, input.images)
            assert.equal(restored.prompt.textAttachments?.[0].text, attachmentText)
            assert.equal(restored.prompt.textAttachments?.[0].filename, 'notes.txt')
            const [liveUser] = events.filter((event) => event.type === 'message_start')
            assert.deepEqual((liveUser as { message: { pastedText?: unknown } }).message.pastedText, normalized.displayMetadata)
            const lastTurn = displayTurnsFromEntries('session', reopened.getBranch()).at(-1)!
            assert.equal(lastTurn.user?.text, normalized.displayMetadata?.body)
            assert.deepEqual(lastTurn.user?.textAttachments, normalized.displayMetadata?.attachments)

            const forked = forkSessionManager(reopened, selected.id, root, join(root, 'forks'))
            assert.deepEqual(forked.restoredPrompt, restored.prompt)
            assert.deepEqual(forked.sessionManager.getEntries().map((entry) => entry.id), [first])
            assert.equal(reopened.getLeafId(), selected.id, 'fork keeps the source history intact')

            session.sessionManager = reopened
            const branchSession = session as unknown as Parameters<typeof switchSessionBranch>[0]
            const edited = await switchSessionBranch(branchSession, selected.id, { restoreUserInput: true })
            assert.deepEqual(edited.restoredPrompt, restored.prompt)

            // Exercise regeneration's actual renderer -> main restoration -> prompt delivery path.
            store.setState({
              runtime: { session: emptyRuntime() }, activeTabId: 'session', currentProjectCwd: root,
              openTabs: [{ id: 'session', cwd: root, title: 'source', kind: 'project', loadState: 'ready' }]
            })
            drafts.getState().discard('session')
            drafts.getState().setContent('session', textToComposerDocument('untouched unsent draft'))
            const unsent = drafts.getState().drafts.session
            api.viewBranch = async (_id, tipId, options) => {
              const branch = await switchSessionBranch(branchSession, tipId, options)
              const turns = displayTurnsFromEntries('session', reopened.getBranch())
              return { ...branch, turns, startIndex: 0, totalTurns: turns.length }
            }
            let resubmitted = false
            api.prompt = async (id, submitted, images, textAttachments) => {
              assert.equal(submitted, normalized.modelText)
              assert.deepEqual(images, input.images)
              assert.deepEqual(textAttachments, restored.prompt.textAttachments)
              await promptSession(id, { text: submitted, images, textAttachments })
              resubmitted = true
              const liveUser = events.findLast((event) => event.type === 'message_start')
              assert.ok(liveUser?.type === 'message_start' && liveUser.message.role === 'user')
              store.getState().appendLiveMessage(id, liveUser.message)
              store.getState().setStreaming(id, false)
            }
            await store.getState().retryUserMessage('session', selected.id)
            assert.equal(resubmitted, true)
            assert.equal(drafts.getState().drafts.session, unsent)
            assert.ok(reopened.getEntry(selected.id), 'regeneration does not erase the old user entry')
            const resent = reopened.getEntries().at(-1)!
            assert.deepEqual(restoreSessionUserPrompt(reopened, resent).prompt, restored.prompt)
          } finally {
            unsubscribe()
          }
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--transformed-prompt-fixture') {
  await fixture()
} else {
  test('transformed direct and queued prompts retain pasted attachments when reopened, edited, forked and regenerated', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--transformed-prompt-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stderr || stdout)
  })
}
