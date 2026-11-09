/** Branch-local, bounded raw evidence windows. No OM or recalled content becomes fresh support. */
import { createHash } from 'node:crypto'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { stripImageHintsFromContent } from '../../../../shared/image-hints'
import { isPastedTextMetadata, PASTED_TEXT_CUSTOM_TYPE, resolvePastedTextMetadata } from '../../../../shared/pasted-text'
import type { MemorySourceRef } from '../../../../shared/long-term-memory'
import type { Entry } from '../session-ledger/types'
import { SENSITIVE_CONTENT, isDerivedMemoryTool } from './hygiene'

export type SourceEntry = Entry & { parentId: string | null }
export interface LearningOrigin { sessionId: string; sessionFile: string; cwd: string; project: string }
export interface LearningSource { ref: MemorySourceRef; text: string; toolName?: string; isError?: boolean; toolCalls?: { name: string; command?: string; path?: string }[]; truncated: boolean }
export interface LearningWindow {
  id: string
  origin: LearningOrigin
  anchorId: string
  entryIds: string[]
  sources: LearningSource[]
  background?: { role: MemorySourceRef['role']; text: string }[]
}
export interface WindowRecord extends Omit<LearningWindow, 'sources' | 'background'> { digests: { id: string; digest: string }[] }
export const sourceHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, Math.floor(limit / 2)) + '\n[... source excerpt omitted ...]\n' + text.slice(-Math.floor(limit / 2))
}

export function learningSource(entry: SourceEntry, origin: LearningOrigin, anchorId: string,
  getEntry: (id: string) => SourceEntry | undefined): LearningSource | undefined {
  if (entry.type !== 'message') return
  const message = entry.message as { role?: string; content?: unknown; timestamp?: number; toolName?: string; isError?: boolean; stopReason?: string }
  if (!['user', 'assistant', 'toolResult'].includes(message.role ?? '')
    || (message.role === 'toolResult' && isDerivedMemoryTool(message.toolName))) return
  const role = message.role as MemorySourceRef['role']
  let text = messageText(message.content)
  if (role === 'user') {
    text = messageText(stripImageHintsFromContent(message.content as Parameters<typeof stripImageHintsFromContent>[0]))
    const parent = entry.parentId ? getEntry(entry.parentId) : undefined
    if (parent?.type === 'custom' && parent.customType === PASTED_TEXT_CUSTOM_TYPE) {
      if (!isPastedTextMetadata(parent.data)) throw new Error('Invalid task learning attachment metadata')
      const resolved = resolvePastedTextMetadata(text, parent.data)
      let cursor = 0
      let clean = ''
      for (const item of [...resolved.metadata.attachments].sort((a, b) => a.start - b.start)) {
        clean += resolved.text.slice(cursor, item.start) + '\n[Pasted attachment omitted]\n'
        cursor = item.end
      }
      text = clean + resolved.text.slice(cursor)
    }
  }
  const calls = role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === 'toolCall').map(block => {
      const name = String(block.name)
      const args = block.arguments as Record<string, unknown> | undefined
      const command = ['bash', 'powershell'].includes(name) && typeof args?.command === 'string' ? args.command : undefined
      const path = ['read', 'write', 'edit'].includes(name) && typeof args?.path === 'string' ? args.path : undefined
      return { name, ...(command && !SENSITIVE_CONTENT.test(command) ? { command: excerpt(command, 1200) } : {}),
        ...(path && !SENSITIVE_CONTENT.test(path) ? { path: excerpt(path, 400) } : {}) }
    }) : []
  // A derived result and the assistant's memory tool call are both excluded from independent evidence.
  if (calls.length && calls.every(call => isDerivedMemoryTool(call.name)) && !text.trim()) return
  if (role === 'assistant' && ['aborted', 'error'].includes(message.stopReason ?? '')) text += '\n[Reply interrupted or failed; not a verified success]'
  if (!text.trim() && !calls.length) return
  const timestamp = message.timestamp ?? entry.timestamp
  if (timestamp === undefined || !Number.isFinite(new Date(timestamp).getTime())) throw new Error('Invalid task source timestamp')
  const sensitive = SENSITIVE_CONTENT.test(text)
  const safe = sensitive ? '[Source omitted: possible credentials; cannot support a claim]' : excerpt(text, role === 'toolResult' ? 2200 : 3200)
  return { ref: { sessionId: origin.sessionId, sessionFile: origin.sessionFile, cwd: origin.cwd, anchorId,
    entryId: entry.id, digest: sourceHash(entry), role, timestamp: new Date(timestamp).toISOString() },
    text: safe, truncated: sensitive || safe !== text, ...(role === 'toolResult' ? { toolName: message.toolName, isError: message.isError !== false } : {}),
    ...(calls.length ? { toolCalls: calls.filter(call => !isDerivedMemoryTool(call.name)) } : {}) }
}

/** Checkpoints are independent of summaries, deletions and siblings in the JSONL tree. */
export function sourceWindow(manager: Pick<ExtensionContext['sessionManager'], 'getLeafId' | 'getEntry'>,
  origin: LearningOrigin, processed: (id: string) => boolean, initializedAt?: string): LearningWindow | undefined {
  const unseen: SourceEntry[] = []
  const seen = new Set<string>()
  let id = manager.getLeafId()
  while (id && !processed(id)) {
    if (seen.has(id)) throw new Error('Cyclic task source branch')
    seen.add(id)
    const entry = manager.getEntry(id) as SourceEntry | undefined
    if (!entry) throw new Error('Missing task source entry')
    unseen.push(entry)
    id = entry.parentId
  }
  if (!unseen.length) return
  unseen.reverse()
  const selected: SourceEntry[] = []
  let bytes = 0
  let messages = 0
  for (const entry of unseen) {
    const source = learningSource(entry, origin, entry.id, key => manager.getEntry(key) as SourceEntry | undefined)
    const size = source ? Buffer.byteLength(JSON.stringify(source)) : 0
    if (selected.length && (bytes + size > 16_000 || messages >= 24 || selected.length >= 256)) break
    selected.push(entry)
    bytes += size
    if (source) messages++
  }
  const anchorId = selected.at(-1)!.id
  const sources = selected.flatMap(entry => {
    const source = learningSource(entry, origin, anchorId, key => manager.getEntry(key) as SourceEntry | undefined)
    return source && (!initializedAt || source.ref.timestamp >= initializedAt) ? [source] : []
  })
  const entryIds = selected.map(entry => entry.id)
  const background: NonNullable<LearningWindow['background']> = []
  let priorId = unseen[0]!.parentId
  let inspected = 0
  while (priorId && inspected++ < 64) {
    const prior = manager.getEntry(priorId) as SourceEntry | undefined
    if (!prior) throw new Error('Missing task background entry')
    const source = learningSource(prior, origin, anchorId, key => manager.getEntry(key) as SourceEntry | undefined)
    if (source && (!initializedAt || source.ref.timestamp >= initializedAt)) {
      if (background.length < 2 || source.ref.role === 'user') background.unshift({ role: source.ref.role, text: excerpt(source.text, 600) })
      if (source.ref.role === 'user') break
    }
    priorId = prior.parentId
  }
  return { id: sourceHash([origin.sessionId, entryIds]), origin, anchorId, entryIds, sources, background }
}
export function windowRecord(window: LearningWindow): WindowRecord {
  return { id: window.id, origin: window.origin, anchorId: window.anchorId, entryIds: window.entryIds,
    digests: window.sources.map(source => ({ id: source.ref.entryId, digest: source.ref.digest })) }
}

export function windowStillValid(window: LearningWindow, manager: Pick<ExtensionContext['sessionManager'], 'getLeafId' | 'getEntry'>): boolean {
  let id = manager.getLeafId()
  const seen = new Set<string>()
  while (id && id !== window.anchorId) {
    if (seen.has(id)) throw new Error('Cyclic task source branch')
    seen.add(id)
    const entry = manager.getEntry(id)
    if (!entry) throw new Error('Missing task source entry')
    id = entry.parentId
  }
  return id === window.anchorId && window.sources.every(source => {
    const entry = manager.getEntry(source.ref.entryId)
    return entry && sourceHash(entry) === source.ref.digest
  })
}
