/**
 * Change review data for the renderer: one worktree's file lists and the patch behind each scope the
 * changes tab has read. Nothing here is derived from Pi sessions, so the store is keyed by worktree
 * path (and, for patches, by the scope that was asked for).
 */
import { create } from 'zustand'
import {
  api,
  DEFAULT_REVIEW_WIDTH,
  MAX_REVIEW_WIDTH,
  MIN_REVIEW_WIDTH,
  type DiffFileEntry,
  type DiffScope,
  type UntrackedFileResult,
  type WorktreeDiff,
  type WorktreePatch
} from '../ipc/api'

export { DEFAULT_REVIEW_WIDTH, MAX_REVIEW_WIDTH, MIN_REVIEW_WIDTH } from '../ipc/api'

export interface WorktreeDiffState {
  status: 'loading' | 'ready' | 'error'
  diff?: WorktreeDiff
  error?: string
  watchError?: string
}

export interface WorktreePatchState {
  status: 'loading' | 'ready' | 'error'
  patch?: WorktreePatch
  error?: string
}

/** How a diff is laid out; one preference for every tab, kept out of the persisted settings. */
export type DiffStyle = 'unified' | 'split'

/** What each scope is called: the tab title, the toolbar control and the two panel groups share it. */
export const SCOPE_LABELS: Record<DiffScope, string> = {
  all: '全部变更',
  staged: '已暂存',
  unstaged: '未提交'
}

/** One cache slot per worktree and scope; the pair is joined with NUL so the key is never ambiguous. */
export function patchKey(cwd: string, scope: DiffScope): string {
  return `${scope}\u0000${cwd}`
}

/**
 * A request from the review column to show one file. It is an action rather than a mode: the changes
 * tab reveals the file once and then consumes it, so the folds it made stay the reader's afterwards.
 */
export interface DiffFocus {
  cwd: string
  path: string
  /** Bumped per request so asking for the same file twice scrolls again. */
  token: number
}

interface DiffStore {
  worktrees: Record<string, WorktreeDiffState>
  patches: Record<string, WorktreePatchState>
  diffStyle: DiffStyle
  setDiffStyle: (style: DiffStyle) => void
  focus: DiffFocus | null
  focusPath: (cwd: string, path: string) => void
  clearFocus: (cwd: string) => void
  /**
   * Which file sections the reader opened, per worktree and path: a fresh canvas has every file folded,
   * and an entry is only written for a file that was asked for.
   */
  expanded: Record<string, Record<string, boolean>>
  setExpanded: (cwd: string, next: Record<string, boolean>) => void
  /**
   * Untracked files the changes tab has read, per worktree and path: an untracked file is not in any
   * diff git prints, so it is read when its card is opened rather than with every refresh.
   */
  untracked: Record<string, Record<string, UntrackedFileResult>>
  loadUntrackedFile: (cwd: string, path: string) => Promise<void>
  /** The file at the top of the changes canvas, so the review column can follow the reading. */
  visible: Record<string, string>
  setVisiblePath: (cwd: string, path: string) => void
  reviewOpen: boolean
  reviewWidth: number
  /** Why the panel's own preferences could not be read or saved, for the alert that says so. */
  prefsError: string | null
  /** Prefs arrive once per renderer: the panel and its toggle both read them. */
  reviewReady: boolean
  loadReviewPrefs: () => Promise<void>
  setReviewOpen: (open: boolean) => void
  /** Live during a drag; `commitReviewWidth` writes the value once the pointer is released. */
  setReviewWidth: (width: number) => void
  commitReviewWidth: () => void
  loadWorktree: (cwd: string) => Promise<void>
  loadWorktreePatch: (cwd: string, scope: DiffScope) => Promise<void>
  /** Drops cached state for a worktree that went away. */
  forgetWorktree: (cwd: string) => void
}

/** Only the newest read may publish, per kind: the watcher can fire several times per edit. */
const scans = new Map<string, number>()
const patchReads = new Map<string, number>()
/**
 * Untracked files being read right now, so two mounts of one card do not ask main twice. The claim of a
 * read stays here until its response arrives: a refresh takes it away, because bytes read before it
 * describe the worktree as it was. One counter for every kind of claim keeps the numbers unique, so a
 * claim that was taken away can never be confused with a newer one.
 */
const untrackedReads = new Map<string, number>()
let claimSeq = 0

function claim(reads: Map<string, number>, key: string): number {
  claimSeq += 1
  reads.set(key, claimSeq)
  return claimSeq
}

/** Takes away one worktree's untracked claims; the reads still in the air have nothing to publish. */
function dropUntrackedClaims(cwd: string): void {
  const suffix = `\u0000${cwd}`
  for (const key of untrackedReads.keys()) {
    if (key.endsWith(suffix)) untrackedReads.delete(key)
  }
}

/** Electron prefixes a rejected invoke with the channel it went through; the card wants main's own words. */
function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

/**
 * The untracked row's line count arrives with the read of its card, not with a refresh — main counted it
 * from the bytes it just handed over. The number is written into every list that holds the path so the
 * card header and the panel row agree with what main will report for the same file until it changes.
 */
function countUntracked(
  state: WorktreeDiffState | undefined,
  path: string,
  lines: number | null
): WorktreeDiffState | undefined {
  if (state?.status !== 'ready' || !state.diff) return state
  const count = (entries: DiffFileEntry[]): DiffFileEntry[] =>
    entries.map((entry) =>
      entry.status === 'untracked' && entry.path === path && entry.additions !== lines
        ? { ...entry, additions: lines, deletions: lines === null ? null : 0 }
        : entry
    )
  const diff = state.diff
  return {
    ...state,
    diff: { ...diff, staged: count(diff.staged), unstaged: count(diff.unstaged), all: count(diff.all) }
  }
}

/**
 * Where each canvas was left, kept outside the store: a scroll writes this on every frame, and no
 * component should re-render for that. Keyed like the patches, so each scope keeps its own place.
 */
const scrollTops = new Map<string, number>()

export function rememberScrollTop(key: string, top: number): void {
  scrollTops.set(key, top)
}

export function savedScrollTop(key: string): number {
  return scrollTops.get(key) ?? 0
}

type PrefField = 'reviewOpen' | 'reviewWidth' | 'read'

/**
 * The panel looks saved the moment its state changes, so a write that fails has to say so somewhere: it
 * otherwise only shows up as a preference that reverted on the next launch. Failures are per field and a
 * success clears only the field it wrote, because `saveSidebarPrefs` merges one field at a time — a width
 * that saved says nothing about the toggle, and clearing the whole message there would hide a change that
 * never reached the disk. Oldest failure first, so the newest unresolved one is what the alert shows.
 */
const prefFailures = new Map<PrefField, string>()

function currentPrefsError(): string | null {
  return [...prefFailures.values()].at(-1) ?? null
}

function notePrefFailure(field: PrefField, error: unknown): void {
  prefFailures.delete(field)
  prefFailures.set(field, failureMessage(error))
}

/** Width writes come from a drag, so they queue instead of racing each other. */
let prefWrites: Promise<unknown> = Promise.resolve()

function savePrefs(
  set: (partial: { prefsError: string | null }) => void,
  patch: { reviewOpen?: boolean; reviewWidth?: number }
): void {
  const fields = Object.keys(patch) as PrefField[]
  prefWrites = prefWrites.then(() => api.setSidebarPrefs(patch)).then(
    () => {
      for (const field of fields) prefFailures.delete(field)
      // A write that landed proves the file can be reached, so it answers a read that failed as well.
      prefFailures.delete('read')
      set({ prefsError: currentPrefsError() })
    },
    (error: unknown) => {
      for (const field of fields) notePrefFailure(field, error)
      set({ prefsError: currentPrefsError() })
    }
  )
}

export const useDiffStore = create<DiffStore>((set, get) => ({
  worktrees: {},
  patches: {},
  diffStyle: 'unified',
  setDiffStyle: (diffStyle) => set({ diffStyle }),
  focus: null,
  focusPath: (cwd, path) => set({ focus: { cwd, path, token: (get().focus?.token ?? 0) + 1 } }),
  clearFocus: (cwd) => {
    if (get().focus?.cwd !== cwd) return
    set({ focus: null })
  },
  expanded: {},
  setExpanded: (cwd, next) => set((state) => ({ expanded: { ...state.expanded, [cwd]: next } })),
  untracked: {},

  loadUntrackedFile: async (cwd, path) => {
    if (get().untracked[cwd]?.[path]) return
    const key = `${path}\u0000${cwd}`
    if (untrackedReads.has(key)) return
    const read = claim(untrackedReads, key)
    /** Lets go of the claim, reporting whether a refresh took it away while the bytes were coming. */
    const overtaken = (): boolean => {
      if (untrackedReads.get(key) !== read) return true
      untrackedReads.delete(key)
      return false
    }
    let result: UntrackedFileResult
    try {
      result = await api.readUntrackedFile(cwd, path)
    } catch (error) {
      // Main answers a file that is gone with `missing` of its own accord, so a rejection here is a read
      // that failed: the card says what happened instead of claiming the file is not there.
      result = { kind: 'failed', message: failureMessage(error) }
    }
    if (overtaken()) {
      // These bytes are for the worktree as it was before the refresh, so they are dropped instead of
      // being written over the fresher lists. A card that is still on screen has asked again in the
      // meantime, and a card whose ask was refused reads on this read's behalf rather than waiting for
      // the next edit to come along.
      if (get().worktrees[cwd]) void get().loadUntrackedFile(cwd, path)
      return
    }
    set((state) => {
      const counted = countUntracked(state.worktrees[cwd], path, result.kind === 'text' ? result.lines : null)
      return {
        untracked: { ...state.untracked, [cwd]: { ...state.untracked[cwd], [path]: result } },
        worktrees: counted ? { ...state.worktrees, [cwd]: counted } : state.worktrees
      }
    })
  },
  visible: {},
  setVisiblePath: (cwd, path) => {
    if (get().visible[cwd] === path) return
    set((state) => ({ visible: { ...state.visible, [cwd]: path } }))
  },
  reviewOpen: false,
  reviewWidth: DEFAULT_REVIEW_WIDTH,
  reviewReady: false,
  prefsError: null,

  loadReviewPrefs: async () => {
    if (get().reviewReady) return
    set({ reviewReady: true })
    try {
      const prefs = await api.getSidebarPrefs()
      set({ reviewOpen: prefs.reviewOpen, reviewWidth: prefs.reviewWidth })
    } catch (error) {
      // Main answers a missing file with its defaults, so a rejection here is a read that failed and the
      // panel is left showing defaults it cannot vouch for.
      notePrefFailure('read', error)
      set({ prefsError: currentPrefsError() })
    }
  },

  setReviewOpen: (reviewOpen) => {
    set({ reviewOpen })
    savePrefs(set, { reviewOpen })
  },

  setReviewWidth: (width) => {
    set({ reviewWidth: Math.min(MAX_REVIEW_WIDTH, Math.max(MIN_REVIEW_WIDTH, Math.round(width))) })
  },

  commitReviewWidth: () => savePrefs(set, { reviewWidth: get().reviewWidth }),

  loadWorktree: async (cwd) => {
    const read = claim(scans, cwd)
    set((state) => ({
      worktrees: {
        ...state.worktrees,
        [cwd]: { ...state.worktrees[cwd], status: 'loading', error: undefined }
      }
    }))
    try {
      const diff = await api.readWorktreeDiff(cwd)
      if (scans.get(cwd) !== read) return
      set((state) => ({
        worktrees: {
          ...state.worktrees,
          [cwd]: { status: 'ready', diff, watchError: state.worktrees[cwd]?.watchError }
        }
      }))
    } catch (error) {
      if (scans.get(cwd) !== read) return
      set((state) => ({
        worktrees: {
          ...state.worktrees,
          [cwd]: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            watchError: state.worktrees[cwd]?.watchError
          }
        }
      }))
    }
  },

  loadWorktreePatch: async (cwd, scope) => {
    const key = patchKey(cwd, scope)
    const read = claim(patchReads, key)
    dropUntrackedClaims(cwd)
    set((state) => ({
      patches: { ...state.patches, [key]: { ...state.patches[key], status: 'loading', error: undefined } },
      // Untracked contents are per card, so a refresh forgets them: a body still on screen asks again
      // and keeps drawing what it had until the new bytes arrive.
      untracked: { ...state.untracked, [cwd]: {} }
    }))
    try {
      const patch = await api.readWorktreePatch(cwd, scope)
      if (patchReads.get(key) !== read) return
      set((state) => ({ patches: { ...state.patches, [key]: { status: 'ready', patch } } }))
    } catch (error) {
      if (patchReads.get(key) !== read) return
      set((state) => ({
        patches: {
          ...state.patches,
          [key]: { status: 'error', error: error instanceof Error ? error.message : String(error) }
        }
      }))
    }
  },

  forgetWorktree: (cwd) => {
    disposeWorktreeWatch(cwd)
    scans.delete(cwd)
    dropUntrackedClaims(cwd)
    const worktrees = { ...get().worktrees }
    const patches = { ...get().patches }
    const expanded = { ...get().expanded }
    const visible = { ...get().visible }
    const untracked = { ...get().untracked }
    delete worktrees[cwd]
    delete expanded[cwd]
    delete visible[cwd]
    delete untracked[cwd]
    for (const key of Object.keys(patches)) {
      if (!key.endsWith(`\u0000${cwd}`)) continue
      delete patches[key]
      patchReads.delete(key)
      scrollTops.delete(key)
    }
    set({
      worktrees,
      patches,
      expanded,
      visible,
      untracked,
      focus: get().focus?.cwd === cwd ? null : get().focus
    })
  }
}))

const WATCH_RETRY_DELAYS = [500, 1_000, 2_000, 5_000, 10_000] as const

interface RendererWatch {
  cwd: string
  holders: number
  scopes: Map<DiffScope, number>
  leaseId?: string
  acquiring?: Promise<string>
  released: boolean
  recovering: boolean
  retryCount: number
  retryTimer?: ReturnType<typeof setTimeout>
  retryDelays: readonly number[]
  unsubscribeChanged: () => void
  unsubscribeError: () => void
}

const rendererWatches = new Map<string, RendererWatch>()

function refreshEntry(entry: RendererWatch): void {
  const store = useDiffStore.getState()
  void store.loadWorktree(entry.cwd)
  for (const scope of entry.scopes.keys()) void store.loadWorktreePatch(entry.cwd, scope)
}

function setWatchError(cwd: string, error?: unknown): void {
  useDiffStore.setState((state) => {
    const current = state.worktrees[cwd]
    if (!current) return state
    const watchError = error === undefined ? undefined : `无法监听工作区变更：${failureMessage(error)}`
    if (current.watchError === watchError) return state
    return { worktrees: { ...state.worktrees, [cwd]: { ...current, watchError } } }
  })
}

function scheduleWatchRetry(entry: RendererWatch): void {
  if (entry.released || entry.retryTimer || entry.acquiring || entry.leaseId) return
  const delay = entry.retryDelays[entry.retryCount]
  if (delay === undefined) return
  entry.retryCount += 1
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = undefined
    acquireWatch(entry)
  }, delay)
}

function watchFailed(entry: RendererWatch, error: unknown): void {
  if (entry.released || rendererWatches.get(entry.cwd) !== entry) return
  entry.leaseId = undefined
  entry.acquiring = undefined
  entry.recovering = true
  setWatchError(entry.cwd, error)
  scheduleWatchRetry(entry)
}

function acquireWatch(entry: RendererWatch): void {
  if (entry.released || entry.acquiring || entry.leaseId) return
  const acquiring = api.watchWorktreeDiff(entry.cwd)
  entry.acquiring = acquiring
  void acquiring.then(
    (leaseId) => {
      if (entry.released || rendererWatches.get(entry.cwd) !== entry) {
        void api.unwatchWorktreeDiff(entry.cwd, leaseId).catch(() => {})
        return
      }
      if (entry.acquiring !== acquiring) {
        void api.unwatchWorktreeDiff(entry.cwd, leaseId).catch(() => {})
        return
      }
      entry.acquiring = undefined
      entry.leaseId = leaseId
      entry.retryCount = 0
      setWatchError(entry.cwd)
      if (entry.recovering) {
        entry.recovering = false
        refreshEntry(entry)
      }
    },
    (error: unknown) => {
      if (entry.acquiring !== acquiring) return
      watchFailed(entry, error)
    }
  )
}

function disposeWorktreeWatch(cwd: string): void {
  const entry = rendererWatches.get(cwd)
  if (!entry) return
  entry.released = true
  clearTimeout(entry.retryTimer)
  entry.unsubscribeChanged()
  entry.unsubscribeError()
  rendererWatches.delete(cwd)
  if (entry.leaseId) void api.unwatchWorktreeDiff(cwd, entry.leaseId).catch(() => {})
}

/** Holds one shared filesystem watch per renderer and worktree. */
export function retainWorktreeWatch(
  cwd: string,
  retryDelays: readonly number[] = WATCH_RETRY_DELAYS
): () => void {
  const existing = rendererWatches.get(cwd)
  if (existing) {
    existing.holders += 1
    if (useDiffStore.getState().worktrees[cwd]?.status === 'error') {
      void useDiffStore.getState().loadWorktree(cwd)
    }
    if (!existing.leaseId && !existing.acquiring && !existing.retryTimer) {
      existing.retryCount = 0
      acquireWatch(existing)
    }
    return () => releaseWorktreeWatch(existing)
  }

  let entry: RendererWatch
  entry = {
    cwd,
    holders: 1,
    scopes: new Map<DiffScope, number>(),
    released: false,
    recovering: false,
    retryCount: 0,
    retryDelays,
    unsubscribeChanged: api.onDiffChanged((changed) => {
      if (changed === cwd && rendererWatches.get(cwd) === entry) refreshEntry(entry)
    }),
    unsubscribeError: api.onDiffWatchError((event) => {
      if (event.cwd !== cwd || event.leaseId !== entry.leaseId) return
      watchFailed(entry, event.message)
    })
  }
  rendererWatches.set(cwd, entry)
  void useDiffStore.getState().loadWorktree(cwd)
  acquireWatch(entry)
  return () => releaseWorktreeWatch(entry)
}

function releaseWorktreeWatch(entry: RendererWatch): void {
  if (entry.released || rendererWatches.get(entry.cwd) !== entry) return
  entry.holders -= 1
  if (entry.holders > 0) return
  disposeWorktreeWatch(entry.cwd)
}

/** Registers one patch scope on the worktree's shared change event. */
export function retainWorktreePatch(cwd: string, scope: DiffScope): () => void {
  const entry = rendererWatches.get(cwd)
  if (!entry) return () => {}
  const holders = entry.scopes.get(scope) ?? 0
  entry.scopes.set(scope, holders + 1)
  if (holders === 0) void useDiffStore.getState().loadWorktreePatch(cwd, scope)
  return () => {
    if (rendererWatches.get(cwd) !== entry) return
    const remaining = (entry.scopes.get(scope) ?? 1) - 1
    if (remaining > 0) entry.scopes.set(scope, remaining)
    else entry.scopes.delete(scope)
  }
}
