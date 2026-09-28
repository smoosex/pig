import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import reviewExtension from '../src/main/plugins/pi-review/index'

type Notification = { message: string; level?: string }

interface Session {
  api: unknown
  ctx: unknown
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>
  handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>
  notifications: Notification[]
  widgetLines: (string[] | undefined)[]
  appended: unknown[]
  sent: string[]
}

// Pi caches extension modules per cwd, so one module instance backs every session in a worktree.
// Calling the factory twice models two Pig sessions sharing that instance.
function createSession(id: string, branch: unknown[] = [], cwd = '/nonexistent-pig-review-workspace'): Session {
  const notifications: Notification[] = []
  const widgetLines: (string[] | undefined)[] = []
  const appended: unknown[] = []
  const sent: string[] = []
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>()
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const ctx = {
    hasUI: true,
    cwd,
    sessionManager: {
      getSessionId: () => id,
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafId: () => 'leaf-1'
    },
    ui: {
      select: async () => undefined,
      editor: async () => undefined,
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setWidget: (_key: string, lines?: string[]) => widgetLines.push(lines)
    },
    navigateTree: async () => ({ cancelled: false })
  }
  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options.handler)
    },
    appendEntry: (_customType: string, data?: unknown) => appended.push(data),
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    sendUserMessage: (content: string) => sent.push(content)
  }
  return { api, ctx, commands, handlers, notifications, widgetLines, appended, sent }
}

function loadExtension(session: Session): void {
  ;(reviewExtension as unknown as (pi: unknown) => void)(session.api)
}

async function emit(session: Session, event: string): Promise<void> {
  for (const handler of session.handlers.get(event) ?? []) await handler({ type: event }, session.ctx)
}

async function runReview(session: Session, args: string): Promise<void> {
  const handler = session.commands.get('review')
  assert.ok(handler, 'review command is registered')
  await handler(args, session.ctx)
}

const reviewState = (originId: string) => ({
  type: 'custom',
  customType: 'review-session',
  data: { active: true, originId }
})

const reviewSettings = (customInstructions: string) => ({
  type: 'custom',
  customType: 'review-settings',
  data: { customInstructions }
})

test('pi-review: an active review in one session does not block or leak into another', async () => {
  const first = createSession('session-a', [reviewState('origin-a')])
  const second = createSession('session-b')
  loadExtension(first)
  loadExtension(second)

  await emit(first, 'session_start')
  assert.deepEqual(first.widgetLines.at(-1), ['Review session active, return with /end-review'])
  await emit(second, 'session_start')
  assert.equal(second.widgetLines.length, 1)
  assert.equal(second.widgetLines[0], undefined)

  // The second session's own (empty) review state must not erase the first session's review.
  await runReview(first, 'uncommitted')
  assert.ok(first.notifications.some((item) => item.message === 'Already in a review. Use /end-review to finish first.'))
  assert.equal(first.sent.length, 0)

  await runReview(second, 'uncommitted')
  assert.ok(!second.notifications.some((item) => item.message.includes('Already in a review')))
  assert.equal(second.sent.length, 1)
})

test('pi-review: unreadable guidelines abort the review before any state is written', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pig-pi-review-'))
  await mkdir(join(workspace, '.pi'))
  await writeFile(join(workspace, 'REVIEW_GUIDELINES.md'), 'Use tabs.\n')
  await chmod(join(workspace, 'REVIEW_GUIDELINES.md'), 0o000)

  // Root can read a 0000 file; then there is no failure left to assert.
  const unreadable = await readFile(join(workspace, 'REVIEW_GUIDELINES.md'), 'utf8').then(() => false, () => true)
  if (!unreadable) return

  const session = createSession('session-a', [], workspace)
  loadExtension(session)
  await emit(session, 'session_start')

  await assert.rejects(() => runReview(session, 'uncommitted'), /Could not read .*REVIEW_GUIDELINES\.md/)
  assert.equal(session.sent.length, 0)
  // Only the session_start deactivation, no activation push.
  assert.deepEqual(session.widgetLines, [undefined])
  assert.deepEqual(session.appended, [])
})

test('pi-review: guidelines that are not a regular file are ignored instead of failing the review', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pig-pi-review-'))
  await mkdir(join(workspace, '.pi'))
  await mkdir(join(workspace, 'REVIEW_GUIDELINES.md'))

  const session = createSession('session-a', [], workspace)
  loadExtension(session)
  await emit(session, 'session_start')

  await runReview(session, 'uncommitted')
  assert.equal(session.sent.length, 1)
  assert.ok(!session.sent[0].includes('project has additional instructions'))
  assert.deepEqual(session.widgetLines.at(-1), ['Review session active, return with /end-review'])
})

test('pi-review: custom review instructions are read from the asking session only', async () => {
  const first = createSession('session-a', [reviewSettings('A-only rules')])
  const second = createSession('session-b')
  loadExtension(first)
  loadExtension(second)

  await emit(first, 'session_start')
  await emit(second, 'session_start')

  await runReview(second, 'uncommitted')
  assert.equal(second.sent.length, 1)
  assert.ok(!second.sent[0].includes('A-only rules'))

  await runReview(first, 'uncommitted')
  assert.equal(first.sent.length, 1)
  assert.ok(first.sent[0].includes('A-only rules'))
})
