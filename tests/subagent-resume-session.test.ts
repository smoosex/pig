import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { openResumeSession } from '../src/main/subagents/resume-session'

describe('subagent resume transcript', () => {
  test('rejects missing, empty and invalid transcripts instead of creating a session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pig-resume-'))
    const path = join(dir, 'session.jsonl')
    try {
      expect(() => openResumeSession(path, dir)).toThrow()
      for (const content of ['', '{}\n', '{"type":"session","id":"x"}\n']) {
        writeFileSync(path, content)
        expect(() => openResumeSession(path, dir)).toThrow()
      }
      const original = SessionManager.create(dir, dir)
      original.appendMessage({ role: 'user', content: 'task', timestamp: Date.now() })
      const file = original.getSessionFile()!
      expect(openResumeSession(file, dir).getSessionId()).toBe(original.getSessionId())
      rmSync(file)
      expect(() => openResumeSession(file, dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
