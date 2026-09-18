/**
 * Joins one scope's file list to lightweight section descriptors. Patch parsing stays out of this
 * list-building pass: an expanded card materializes only its own patch when it reaches the viewport.
 */
import { getSingularPatch, parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'
import type {
  DiffFileEntry,
  DiffScope,
  UntrackedFileResult,
  WorktreeDiff,
  WorktreePatch
} from '../../ipc/api'

export type SectionNote =
  | 'binary'
  | 'too-large'
  | 'changed'
  | 'failed'
  | 'truncated'
  | 'unparsed'
  | 'empty'
  | null

type SectionSource =
  | { kind: 'patch'; patch: WorktreePatch }
  | { kind: 'text'; contents: string }

export interface DiffSection {
  entry: DiffFileEntry
  fileDiff: FileDiffMetadata | null
  note: SectionNote
  bytes?: number
  message?: string
  pending: boolean
  source?: SectionSource
}

export const SECTION_SCROLL_LINES = 1200

export function scopeEntries(diff: WorktreeDiff | undefined, scope: DiffScope): DiffFileEntry[] {
  return diff?.[scope] ?? []
}

export function buildSections(
  diff: WorktreeDiff | undefined,
  patch: WorktreePatch | undefined,
  scope: DiffScope,
  untracked: Record<string, UntrackedFileResult>
): DiffSection[] {
  return scopeEntries(diff, scope).map((entry) => {
    if (entry.status === 'untracked') return untrackedSection(entry, untracked[entry.path])
    if (!patch) return { entry, fileDiff: null, note: null, pending: true }
    if (!patch.git) return { entry, fileDiff: null, note: 'empty', pending: false }
    if (entry.additions === null && entry.deletions === null) {
      return { entry, fileDiff: null, note: 'binary', pending: false }
    }
    return {
      entry,
      fileDiff: null,
      note: null,
      pending: false,
      source: { kind: 'patch', patch }
    }
  })
}

export function materializeSection(section: DiffSection): DiffSection {
  const source = section.source
  if (!source) return section
  if (source.kind === 'text') {
    try {
      return {
        ...section,
        fileDiff: parseDiffFromFile(null, { name: section.entry.path, contents: source.contents }),
        source: undefined
      }
    } catch (error) {
      return {
        ...section,
        note: 'unparsed',
        message: error instanceof Error ? error.message : String(error),
        source: undefined
      }
    }
  }

  const resolved = resolvePatchFile(source.patch, section.entry.path)
  if (resolved.fileDiff) return { ...section, fileDiff: resolved.fileDiff, source: undefined }
  return {
    ...section,
    note: source.patch.truncated ? 'truncated' : 'unparsed',
    message: resolved.message,
    source: undefined
  }
}

interface PatchIndex {
  chunks: string[]
  cursor: number
  files: Map<string, FileDiffMetadata>
  error?: string
}

const patchIndexes = new WeakMap<WorktreePatch, PatchIndex>()

function resolvePatchFile(
  patch: WorktreePatch,
  path: string
): { fileDiff?: FileDiffMetadata; message?: string } {
  let index = patchIndexes.get(patch)
  if (!index) {
    index = { chunks: splitPatch(patch.patch), cursor: 0, files: new Map() }
    patchIndexes.set(patch, index)
  }
  const cached = index.files.get(path)
  if (cached) return { fileDiff: cached }

  while (index.cursor < index.chunks.length) {
    const chunk = index.chunks[index.cursor++]!
    try {
      const file = getSingularPatch(chunk)
      index.files.set(file.name, file)
      if (file.name === path) return { fileDiff: file }
    } catch (error) {
      index.error = error instanceof Error ? error.message : String(error)
    }
  }
  return { fileDiff: index.files.get(path), message: index.error }
}

function splitPatch(patch: string): string[] {
  if (!patch.trim()) return []
  const starts: number[] = []
  const marker = /^diff --git /gm
  for (let match = marker.exec(patch); match; match = marker.exec(patch)) starts.push(match.index)
  if (!starts.length) return [patch]
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length))
}

function untrackedSection(entry: DiffFileEntry, file: UntrackedFileResult | undefined): DiffSection {
  if (!file) return { entry, fileDiff: null, note: null, pending: true }
  if (file.kind === 'text') {
    return {
      entry,
      fileDiff: null,
      note: null,
      pending: false,
      source: { kind: 'text', contents: file.contents }
    }
  }
  if (file.kind === 'too-large') {
    return { entry, fileDiff: null, note: 'too-large', bytes: file.bytes, pending: false }
  }
  if (file.kind === 'binary') return { entry, fileDiff: null, note: 'binary', pending: false }
  if (file.kind === 'blocked') return { entry, fileDiff: null, note: 'changed', pending: false }
  if (file.kind === 'failed') {
    return { entry, fileDiff: null, note: 'failed', message: file.message, pending: false }
  }
  return { entry, fileDiff: null, note: 'empty', pending: false }
}

export function sectionId(path: string): string {
  return `diff-section:${path}`
}
