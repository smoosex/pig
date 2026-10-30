/** Aggregate a raw current branch, without reading files or projecting away compacted operations. */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  FileChangeOperation,
  SessionFileChange,
  SessionFileChanges
} from '../../shared/session-file-changes'
import { displayTurnOwners } from './session-display-model'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizePath(input: string): string {
  let path = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
  if (path.startsWith('@')) path = path.slice(1)
  if (process.platform === 'win32' && !path.includes('\\')) {
    path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_, drive: string, rest: string | undefined) => `${drive.toUpperCase()}:\\${(rest ?? '').replaceAll('/', '\\')}`)
  }
  if (path === '~') return homedir()
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
    return resolve(homedir(), path.slice(2))
  }
  return path.startsWith('file://') ? fileURLToPath(path) : path
}

function counts(patch: string): { added: number; removed: number; unknown: boolean } {
  let added = 0
  let removed = 0
  let oldLeft = 0
  let newLeft = 0
  let found = false
  for (const line of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      if (oldLeft || newLeft) return { added: 0, removed: 0, unknown: true }
      oldLeft = Number(hunk[1] ?? 1)
      newLeft = Number(hunk[2] ?? 1)
      found = true
    } else if (oldLeft || newLeft) {
      if (line.startsWith('\\')) continue
      if (line.startsWith('+') && newLeft > 0) { added++; newLeft-- }
      else if (line.startsWith('-') && oldLeft > 0) { removed++; oldLeft-- }
      else if (line.startsWith(' ') && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft-- }
      else return { added: 0, removed: 0, unknown: true }
    }
  }
  return found && !oldLeft && !newLeft
    ? { added, removed, unknown: false }
    : { added: 0, removed: 0, unknown: true }
}

function operation(id: string, tool: 'edit' | 'write', details?: unknown): FileChangeOperation {
  const result: FileChangeOperation = { id, tool, added: 0, removed: 0, unknown: true }
  const data = object(details)
  if (typeof data?.patch === 'string') {
    result.patch = data.patch
    Object.assign(result, counts(data.patch))
  } else if (typeof data?.diff === 'string') {
    result.diff = data.diff
    const lines = data.diff.split(/\r?\n/)
    result.added = lines.filter((line) => /^\+\s*\d+ /.test(line)).length
    result.removed = lines.filter((line) => /^-\s*\d+ /.test(line)).length
    result.unknown = result.added + result.removed === 0
  }
  return result
}

/**
 * `write` records only what it wrote, so its change is shown as the whole content added. Whatever the
 * file held before is deliberately ignored: an overwrite reads as a new file.
 */
function writtenPatch(path: string, content: string): string {
  const lines = content.split(/\r?\n/)
  const newline = lines.at(-1) === ''
  if (newline) lines.pop()
  const body = lines.map((line) => `+${line}`)
  if (!newline) body.push('\\ No newline at end of file')
  return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...body, ''].join('\n')
}

function append(files: Map<string, SessionFileChange>, path: string, op: FileChangeOperation): void {
  let file = files.get(path)
  if (!file) {
    file = { path, added: 0, removed: 0, unknownOperations: 0, operations: [] }
    files.set(path, file)
  }
  file.added += op.added
  file.removed += op.removed
  file.unknownOperations += Number(op.unknown)
  file.operations.push({ ...op })
}

/** Entries must be the current branch in chronological order, not all session-tree entries. */
export function summarizeSessionFileChanges(entries: readonly SessionEntry[], cwd: string): SessionFileChanges {
  const files = new Map<string, SessionFileChange>()
  const turns = new Map<string, Map<string, SessionFileChange>>()
  const calls = new Map<string, { name: string; arguments: unknown; turnId: string | undefined }>()
  const add = (id: string, name: string, args: unknown, owner: string | undefined, details?: unknown): void => {
    if (name !== 'edit' && name !== 'write') return
    const path = object(args)?.path
    if (typeof path !== 'string' || path.length === 0 || path === '@') return
    const absolute = resolve(normalizePath(cwd), normalizePath(path))
    const op = operation(id, name, details)
    const content = object(args)?.content
    if (name === 'write' && op.unknown && !op.patch && !op.diff && typeof content === 'string') {
      if (content) Object.assign(op, { patch: writtenPatch(path, content) }, counts(writtenPatch(path, content)))
      else Object.assign(op, { added: 0, removed: 0, unknown: false })
    }
    append(files, absolute, op)
    if (owner !== undefined) append(turns.get(owner)!, absolute, op)
  }
  // Turn ids must be the ones the conversation renders, so a `!cmd` group or a leading group owns its own edits.
  const owners = displayTurnOwners([...entries])
  for (const id of new Set(owners.values())) turns.set(id, new Map())
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message
    const turnId = owners.get(entry.id)
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') calls.set(block.id, { name: block.name, arguments: block.arguments, turnId })
      }
    } else if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId)
      if (!call || call.name !== message.toolName) continue
      calls.delete(message.toolCallId)
      if (message.isError === false) add(message.toolCallId, call.name, call.arguments, call.turnId, message.details)
      // A parent script can fail after a nested write has already succeeded.
      const seen = new Set<string>()
      for (const nested of message.nestedCalls?.calls ?? []) {
        if (nested.status !== 'ok' || seen.has(nested.id)) continue
        seen.add(nested.id)
        add(nested.id, nested.name, nested.arguments, call.turnId)
      }
    }
  }
  return { files: [...files.values()], turns: Object.fromEntries([...turns].map(([id, changes]) => [id, [...changes.values()]])) }
}
