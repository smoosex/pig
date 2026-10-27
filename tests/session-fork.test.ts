import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { forkSessionManager } from '../src/main/pi/session-fork'
import { composePromptText, createPastedTextMetadata, PASTED_TEXT_CUSTOM_TYPE, utf8ByteLength } from '../src/shared/pasted-text'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pig-session-fork-'))
  roots.push(root)
  const cwd = join(root, 'project')
  const sourceDir = join(root, 'source-sessions')
  const targetDir = join(root, 'target-sessions')
  const source = SessionManager.create(cwd, sourceDir)
  return { cwd, source, sourceDir, targetDir }
}

const user = (text: string, timestamp = 1) => ({
  role: 'user' as const,
  content: text,
  timestamp
})

test('fork creates a separate Pi session before the selected user message', () => {
  const { cwd, source, targetDir } = fixture()
  const first = source.appendMessage(user('第一轮'))
  const attachment = {
    id: 'paste-1',
    text: '完整粘贴内容',
    byteSize: utf8ByteLength('完整粘贴内容')
  }
  const modelText = composePromptText('第二轮', [attachment])
  source.appendCustomEntry(PASTED_TEXT_CUSTOM_TYPE, createPastedTextMetadata('第二轮', [attachment]))
  const selected = source.appendMessage({
    role: 'user' as const,
    timestamp: 2,
    content: [
      {
        type: 'text' as const,
        text: `${modelText}\n\n[Image: original 10x10, displayed at 10x10. Multiply coordinates by 1.00 to map to original image.]`
      },
      { type: 'image' as const, mimeType: 'image/png' as const, data: 'aW1hZ2U=' }
    ]
  })
  const sourcePath = source.getSessionFile()!

  const forked = forkSessionManager(source, selected, cwd, targetDir)

  assert.notEqual(forked.sessionManager.getSessionId(), source.getSessionId())
  assert.equal(forked.sessionManager.getHeader()?.parentSession, sourcePath)
  assert.deepEqual(forked.sessionManager.getEntries().map((entry) => entry.id), [first])
  assert.equal(forked.sessionManager.getLeafId(), first)
  assert.equal(source.getLeafId(), selected, 'the source session stays on its original branch')
  assert.ok(existsSync(forked.sessionManager.getSessionFile()!))
  assert.deepEqual(forked.restoredPrompt, {
    text: modelText,
    images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
    textAttachments: [{
      ...attachment,
      start: '第二轮'.length + 2,
      end: modelText.length
    }]
  })
})

test('forking the first user message creates an empty child session and restores its input', () => {
  const { cwd, source, targetDir } = fixture()
  const selected = source.appendMessage(user('首轮问题'))
  const sourcePath = source.getSessionFile()!

  const forked = forkSessionManager(source, selected, cwd, targetDir)

  assert.deepEqual(forked.sessionManager.getEntries(), [])
  assert.equal(forked.sessionManager.getHeader()?.parentSession, sourcePath)
  assert.equal(existsSync(forked.sessionManager.getSessionFile()!), false)
  assert.deepEqual(forked.restoredPrompt, { text: '首轮问题', images: [] })
})

test('the first pasted-text prompt forks before its metadata root', () => {
  const { cwd, source, targetDir } = fixture()
  const attachment = { id: 'paste', text: '附件原文', byteSize: 12 }
  source.appendCustomEntry(PASTED_TEXT_CUSTOM_TYPE, createPastedTextMetadata('问题', [attachment]))
  const selected = source.appendMessage(user(composePromptText('问题', [attachment])))
  const forked = forkSessionManager(source, selected, cwd, targetDir)
  assert.deepEqual(forked.sessionManager.getEntries(), [])
  assert.equal(forked.restoredPrompt?.textAttachments?.[0].text, attachment.text)
})

test('forking at a reply keeps the whole turn and restores no input', () => {
  const { cwd, source, targetDir } = fixture()
  const question = source.appendMessage(user('问题'))
  const reply = source.appendMessage({
    role: 'assistant' as const, timestamp: 2, content: [{ type: 'text' as const, text: '回答' }],
    api: 'test', provider: 'test', model: 'test', stopReason: 'stop' as const,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  })
  source.appendMessage(user('之后的问题'))

  const forked = forkSessionManager(source, reply, cwd, targetDir, 'at')

  assert.deepEqual(forked.sessionManager.getEntries().map((entry) => entry.id), [question, reply])
  assert.equal(forked.sessionManager.getLeafId(), reply)
  assert.equal(forked.restoredPrompt, undefined)
})

test('fork fails when pasted-text metadata does not match the user entry', () => {
  const { cwd, source, targetDir } = fixture()
  const attachment = { id: 'paste', text: '原文', byteSize: 6 }
  source.appendCustomEntry(PASTED_TEXT_CUSTOM_TYPE, createPastedTextMetadata('问题', [attachment]))
  const selected = source.appendMessage(user('被篡改的内容'))
  assert.throws(
    () => forkSessionManager(source, selected, cwd, targetDir),
    (error: unknown) => (error as { code?: string }).code === 'PASTED_TEXT_METADATA_MISMATCH'
  )
})

test('fork rejects entries that are not user messages', () => {
  const { cwd, source, targetDir } = fixture()
  source.appendMessage(user('问题'))
  const custom = source.appendCustomEntry('checkpoint', {})
  assert.throws(
    () => forkSessionManager(source, custom, cwd, targetDir),
    /Entry is not a user message/
  )
})
