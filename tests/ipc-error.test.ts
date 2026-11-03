/** Error formatting at renderer IPC boundaries; the source audit is a syntactic tripwire, not IPC inference. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failureMessage } from '../src/renderer/src/lib/ipc-error'

test('IPC failures lose the invoke prefix without altering local errors', () => {
  assert.equal(failureMessage(new Error("Error invoking remote method 'files:read': Error: denied")), 'denied')
  assert.equal(failureMessage(new Error("Error invoking remote method 'settings:save': cancelled")), 'cancelled')
  assert.equal(failureMessage("Error invoking remote method 'skills:read': Error: missing"), 'missing')
  assert.equal(failureMessage(new Error('invalid local JSON')), 'invalid local JSON')
  assert.equal(failureMessage('clipboard denied'), 'clipboard denied')
  assert.equal(failureMessage(null), 'null')
})

test('renderer raw error conversions stay confined to reviewed non-IPC sites', () => {
  const root = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
  const expected: Record<string, number> = {
    'lib/ipc-error.ts': 1, // The formatter itself.
    'stores/settings.ts': 2, // Surface reply to main and local shortcut validation.
    'components/diff/sections.ts': 2, // Local diff parsing.
    'components/settings/AddMcpDialog.tsx': 2, // JSON/argv conversion and pasted config parsing.
    'components/turn/AssistantMessageActions.tsx': 2, // Clipboard failures.
    'components/turn/UserMessageActions.tsx': 2, // Clipboard failures.
    'terminal/runtime.ts': 1 // Font loading.
  }
  const actual: Record<string, number> = {}
  function scan(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(path, 'utf8')
        const conversions = source.match(/\b(\w+)\s+instanceof Error\s*\?\s*\1\.message\s*:\s*String\(\1\)|\bString\((?:error|err|reason|cause|failure|unknown|e)\)/g)
        if (conversions) actual[relative(root, path).replaceAll('\\', '/')] = conversions.length
      }
    }
  }
  scan(root)
  assert.deepEqual(actual, expected, 'review new raw conversions; use failureMessage for IPC rejections')
})
