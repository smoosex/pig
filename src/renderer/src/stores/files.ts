/**
 * The file tree and the file tabs: one directory level per worktree as the reader opens it, and one
 * document per file a tab has opened.
 *
 * A document holds both the draft and the bytes it started from, so "dirty" is a comparison between the
 * two and a save can say whether the file moved on underneath it. Documents outlive their tabs — a draft
 * stays in memory after its tab closes, so reopening the file finds the work still there — and only a
 * clean one is dropped, which keeps the store from growing with every file that was peeked at.
 *
 * Main pushes one change event per worktree for the whole app, the same one the changes panel refreshes
 * on: every level the tree has open and every document is refreshed from it, so an edit made by the agent,
 * or by another editor, reaches this column without a reload of its own.
 */
import { create } from 'zustand'
import { api, type FileReadResult, type FileStamp, type FileTreeEntry } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'

export interface DirectoryState {
  status: 'loading' | 'ready' | 'error'
  entries?: FileTreeEntry[]
  error?: string
}

/** Why a file has no editor: the tab says so rather than showing an empty document. */
export type FilePreview = 'text' | 'binary' | 'too-large' | 'link' | 'missing'

export interface FileDocument {
  status: 'loading' | 'ready' | 'error'
  preview: FilePreview
  /** The draft, and the bytes it was read from: this pair is what dirty means. */
  text: string
  saved: string
  /** The stamp `saved` was read at, which every write is compared against. */
  stamp: FileStamp | null
  /** Bumped by every read that replaces the draft, so the editor remounts on the bytes that came back. */
  revision: number
  /** The file changed on disk while a draft was being edited. */
  stale: boolean
  /** A background refresh could not read the file, so nothing on screen is known to be current. */
  refreshError?: string
  /** Bytes on disk, for a preview that was refused for its size or because it is not text. */
  bytes: number | null
  error?: string
  saving: boolean
  saveError?: string
}

/** One document per worktree and path; joined with NUL so the key is never ambiguous. */
export function fileKey(cwd: string, path: string): string {
  return `${path}\u0000${cwd}`
}

/** Whether the editor holds something that has not reached the disk yet. */
export function isDirty(document: FileDocument): boolean {
  return document.text !== document.saved
}

/**
 * A line a file tab was asked to land on, asked for by the changes tab when a diff line is followed.
 *
 * The request is one-shot and lives outside the tab: a tab that is not mounted yet — one the changes tab
 * just opened — reads it when its document arrives, and the tab takes it off the store once the editor
 * has been told, so switching away and back does not replay it. `token` is what makes a repeat of the
 * same line a new request, the same way the changes tab's own file focus works.
 */
export interface FileReveal {
  cwd: string
  path: string
  line: number
  token: number
}

interface FilesStore {
  /** Directory listings per worktree, then per worktree-relative path. */
  trees: Record<string, Record<string, DirectoryState>>
  /** Which directories the reader has opened; a worktree starts with nothing open. */
  expanded: Record<string, Record<string, boolean>>
  documents: Record<string, FileDocument>
  hideIgnored: boolean
  loadDirectory: (cwd: string, path: string) => Promise<void>
  toggleDirectory: (cwd: string, path: string) => void
  setHideIgnored: (hide: boolean) => void
  openDocument: (cwd: string, path: string) => Promise<void>
  setDraft: (cwd: string, path: string, text: string) => void
  saveDocument: (cwd: string, path: string, overwrite?: boolean) => Promise<void>
  reloadDocument: (cwd: string, path: string) => Promise<void>
  releaseDocument: (cwd: string, path: string) => void
  /** Reloads what this worktree has open: the levels on screen and every document. */
  refreshWorktree: (cwd: string) => void
  /** The line a tab is being asked to land on, or null when nothing is waiting to be revealed. */
  reveal: FileReveal | null
  revealLine: (cwd: string, path: string, line: number) => void
  clearReveal: () => void
}

/**
 * Only the newest read of a key may publish. A reload asked for while a read is in flight has to win,
 * and a closed tab has to be able to take its key away, which is why reads carry a claim rather than a
 * mere counter: a read whose claim is gone drops its answer instead of writing it.
 */
const reads = new Map<string, number>()
let readCount = 0

function claim(key: string): number {
  readCount += 1
  reads.set(key, readCount)
  return readCount
}

function update(key: string, change: (document: FileDocument) => FileDocument): void {
  useFilesStore.setState((state) => {
    const document = state.documents[key]
    if (!document) return state
    return { documents: { ...state.documents, [key]: change(document) } }
  })
}

function newDocument(): FileDocument {
  return {
    status: 'loading',
    preview: 'text',
    text: '',
    saved: '',
    stamp: null,
    revision: 0,
    stale: false,
    bytes: null,
    saving: false
  }
}

/** A file the tab cannot edit: no draft, and a preview that says which kind it is. */
function refusal(document: FileDocument, preview: FilePreview, bytes: number | null): FileDocument {
  return {
    ...document,
    status: 'ready',
    preview,
    text: '',
    saved: '',
    stamp: null,
    bytes,
    stale: false,
    error: undefined,
    saving: false
  }
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  trees: {},
  expanded: {},
  documents: {},
  hideIgnored: false,

  loadDirectory: async (cwd, path) => {
    const key = fileKey(cwd, path)
    const claimId = claim(key)
    // A level that is already listing keeps its rows while the refresh is on its way; only the first
    // read of a directory has nothing to show and says it is loading.
    if (!get().trees[cwd]?.[path]?.entries) {
      set((state) => ({
        trees: { ...state.trees, [cwd]: { ...state.trees[cwd], [path]: { status: 'loading' } } }
      }))
    }
    let listing: { entries: FileTreeEntry[] } | null = null
    const failure = await api.readDirectory(cwd, path).then(
      (result) => {
        listing = result
        return null
      },
      (error: unknown) => failureMessage(error)
    )
    if (reads.get(key) !== claimId) return
    set((state) => ({
      trees: {
        ...state.trees,
        [cwd]: {
          ...state.trees[cwd],
          [path]: listing
            ? { status: 'ready', entries: listing.entries }
            : { status: 'error', error: failure ?? undefined }
        }
      }
    }))
  },

  toggleDirectory: (cwd, path) => {
    const open = !get().expanded[cwd]?.[path]
    set((state) => ({
      expanded: { ...state.expanded, [cwd]: { ...state.expanded[cwd], [path]: open } }
    }))
    // Opening a directory reads it again: what the tree kept for it may be as old as the last time it
    // was on screen, and the change events it would have heard were only ever for the levels that were.
    if (open) void get().loadDirectory(cwd, path)
  },

  setHideIgnored: (hideIgnored) => set({ hideIgnored }),

  openDocument: async (cwd, path) => {
    const document = get().documents[fileKey(cwd, path)]
    if (document?.status === 'ready' || document?.status === 'loading') return
    await get().reloadDocument(cwd, path)
  },

  setDraft: (cwd, path, text) => {
    const key = fileKey(cwd, path)
    if (get().documents[key]?.text === text) return
    update(key, (document) => ({ ...document, text }))
  },

  /**
   * Writes the draft back. The answer decides what happens next: `conflict` means the file is no longer
   * the one the draft was written against, and only the reader — who is looking at that answer — can ask
   * for the write anyway. A save keeps whatever was typed while it was in flight, so the draft stays
   * dirty until that is written too, and the stamp it records is the file as this write left it.
   */
  saveDocument: async (cwd, path, overwrite = false) => {
    const key = fileKey(cwd, path)
    const document = get().documents[key]
    if (!document || document.status !== 'ready' || document.preview !== 'text' || document.saving) return
    const text = document.text
    update(key, (current) => ({ ...current, saving: true, saveError: undefined }))
    try {
      const result = await api.writeFile(cwd, path, text, {
        expected: document.stamp ?? undefined,
        overwrite
      })
      update(key, (current) => result.kind === 'written'
        ? {
            ...current,
            saving: false,
            saved: text,
            stamp: { mtimeMs: result.mtimeMs, size: result.size },
            stale: false
          }
        : { ...current, saving: false, stale: true })
    } catch (error) {
      update(key, (current) => ({ ...current, saving: false, saveError: failureMessage(error) }))
    }
  },

  /** Reads the file again, replacing the draft with what is on disk now. */
  reloadDocument: async (cwd, path) => {
    const key = fileKey(cwd, path)
    const claimId = claim(key)
    const previous = get().documents[key]
    set((state) => ({
      documents: {
        ...state.documents,
        [key]: previous
          ? { ...previous, status: 'loading', error: undefined, stale: false, refreshError: undefined }
          : newDocument()
      }
    }))
    let result: FileReadResult
    try {
      result = await api.readFile(cwd, path)
    } catch (error) {
      if (reads.get(key) !== claimId) return
      update(key, (document) => ({ ...document, status: 'error', error: failureMessage(error) }))
      return
    }
    if (reads.get(key) !== claimId) return
    // The read came back, so whatever the last background refresh failed to do is no longer this
    // document's story: the answer in hand replaces it either way.
    update(key, (document) => ({
      ...(result.kind === 'text'
        ? {
            ...document,
            status: 'ready',
            preview: 'text',
            text: result.contents,
            saved: result.contents,
            stamp: { mtimeMs: result.mtimeMs, size: result.size },
            bytes: result.size,
            revision: document.revision + 1,
            stale: false,
            error: undefined,
            saving: false,
            saveError: undefined
          }
        : refusal(document, result.kind, 'size' in result ? result.size : null)),
      refreshError: undefined
    }))
  },

  /** A tab that closes keeps its draft and lets a clean document go. */
  releaseDocument: (cwd, path) => {
    const key = fileKey(cwd, path)
    reads.delete(key)
    set((state) => {
      const document = state.documents[key]
      if (!document || isDirty(document) || document.saving) return state
      const documents = { ...state.documents }
      delete documents[key]
      return { documents }
    })
  },

  refreshWorktree: (cwd) => {
    const state = get()
    for (const path of Object.keys(state.trees[cwd] ?? {})) {
      if (path === '' || state.expanded[cwd]?.[path]) void get().loadDirectory(cwd, path)
    }
    for (const key of Object.keys(state.documents)) {
      if (key.endsWith(`\u0000${cwd}`)) void refreshDocument(cwd, key.slice(0, key.indexOf('\u0000')))
    }
  },

  reveal: null,
  revealLine: (cwd, path, line) =>
    set((state) => ({ reveal: { cwd, path, line, token: (state.reveal?.token ?? 0) + 1 } })),
  clearReveal: () => set({ reveal: null })
}))

/**
 * What a change event means for one open document. Main only says which worktree changed, so a read that
 * fails says nothing about this file: the failure is recorded and the document is left on whatever the
 * last read brought in, rather than being called a change.
 */
async function refreshDocument(cwd: string, path: string): Promise<void> {
  const key = fileKey(cwd, path)
  const document = useFilesStore.getState().documents[key]
  if (!document || document.status !== 'ready') return
  const claimId = claim(key)
  let result: FileReadResult
  try {
    result = await api.readFile(cwd, path)
  } catch (error) {
    // A read that another one has already moved past has nothing to say, including this.
    if (reads.get(key) !== claimId) return
    update(key, (current) => ({ ...current, refreshError: failureMessage(error) }))
    return
  }
  if (reads.get(key) !== claimId) return
  update(key, (current) => ({ ...refreshed(current, result), refreshError: undefined }))
}

/**
 * What the bytes that just came back mean for the draft: bytes the draft was written against change
 * nothing, anything else is adopted while the tab is clean and flagged as stale while it is not. A draft
 * is never replaced by bytes the reader has not seen, and a clean tab never keeps showing a version of
 * the file that no longer exists.
 */
function refreshed(current: FileDocument, result: FileReadResult): FileDocument {
  if (isDirty(current)) {
    return result.kind === 'text' && result.contents === current.saved
      ? { ...current, stamp: { mtimeMs: result.mtimeMs, size: result.size }, stale: false }
      : { ...current, stale: true }
  }
  if (result.kind !== 'text') {
    return refusal(current, result.kind, 'size' in result ? result.size : null)
  }
  if (result.contents === current.saved) {
    return { ...current, stamp: { mtimeMs: result.mtimeMs, size: result.size }, stale: false }
  }
  return {
    ...current,
    text: result.contents,
    saved: result.contents,
    stamp: { mtimeMs: result.mtimeMs, size: result.size },
    bytes: result.size,
    revision: current.revision + 1,
    stale: false
  }
}

let watching = false

/** Main pushes one event per worktree for whoever is listening; this store only has to be one of them. */
export function watchWorktreeFiles(): void {
  if (watching) return
  watching = true
  api.onDiffChanged((cwd) => useFilesStore.getState().refreshWorktree(cwd))
}
