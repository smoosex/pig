/**
 * Global history of committed browser pages, shared by every tab and window like the one cookie partition.
 *
 * Main owns the only copy in memory; the UI asks for ranked matches and never receives the whole list.
 * Writes are debounced and serialized behind one queue, replacing the file atomically (0600: URLs keep
 * their query, which can carry tokens). A file that fails to load is never overwritten: history stays
 * unavailable until it is fixed or removed by hand.
 *
 * Favicons are kept per origin beside the pages, as small PNG data URLs, and go with the last page of
 * their origin. Fetching them is the recorder's job; this store only decides whether one is wanted.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserHistoryCursor, BrowserHistoryEntry, BrowserHistoryPage } from '../../shared/browser'
import type { BrowserPageEvents } from './host'
import { pigPath } from '../pig-dir'
import { isBrowserUrl } from './validation'

const VERSION = 1
const MAX_ENTRIES = 2000
const MAX_URL_LENGTH = 8192
const MAX_TITLE_LENGTH = 512
const MAX_QUERY_LENGTH = 512
const MAX_RESULTS = 20
const MAX_PAGE = 100
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000
const WRITE_DELAY_MS = 2000
const MAX_ICON_LENGTH = 64 * 1024
const ICON_PREFIX = 'data:image/png;base64,'
const MAX_ICON_CANDIDATES = 3

interface StoredIcon {
  /** The icon URL it came from; a page announcing the same one again needs no fetch. */
  source: string
  data: string
}

function parseEntry(value: unknown): BrowserHistoryEntry {
  const entry = value as BrowserHistoryEntry
  if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.title !== 'string' ||
    ![entry.visitCount, entry.typedCount, entry.lastVisitAt].every(Number.isSafeInteger) ||
    entry.visitCount < 0 || entry.typedCount < 0 || entry.lastVisitAt < 0 || !isBrowserUrl(entry.url)) {
    throw new Error('Invalid browser history entry')
  }
  return { url: entry.url, title: entry.title, visitCount: entry.visitCount, typedCount: entry.typedCount, lastVisitAt: entry.lastVisitAt }
}

function frecency(entry: BrowserHistoryEntry, now: number): number {
  const age = Math.max(0, now - entry.lastVisitAt)
  return (entry.visitCount + 2 * entry.typedCount) * 0.5 ** (age / HALF_LIFE_MS)
}

function originOf(url: string): string | null {
  try { return new URL(url).origin } catch { return null }
}

/** Sites differing only by a leading www. share one top-site tile. */
function siteOf(url: string): string {
  return new URL(url).host.replace(/^www\./i, '').toLowerCase()
}

function parseIcons(value: unknown): Map<string, StoredIcon> {
  const icons = new Map<string, StoredIcon>()
  if (value === undefined) return icons
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser history icons')
  for (const [origin, raw] of Object.entries(value)) {
    const icon = raw as StoredIcon
    if (!icon || typeof icon !== 'object' || originOf(origin) !== origin || typeof icon.source !== 'string' || !isBrowserUrl(icon.source) ||
      typeof icon.data !== 'string' || !icon.data.startsWith(ICON_PREFIX) || icon.data.length > MAX_ICON_LENGTH) {
      throw new Error('Invalid browser history icon')
    }
    icons.set(origin, { source: icon.source, data: icon.data })
  }
  return icons
}

/** Scheme and a leading www. are noise when matching what the user types. */
function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase()
}

function startsWord(text: string, token: string): boolean {
  let index = text.indexOf(token)
  while (index !== -1) {
    if (index === 0 || /[^\p{L}\p{N}]/u.test(text[index - 1]!)) return true
    index = text.indexOf(token, index + 1)
  }
  return false
}

/** Newest first; URL breaks ties so a cursor resumes exactly where the previous page ended. */
function byRecency(a: BrowserHistoryEntry, b: BrowserHistoryEntry): number {
  return b.lastVisitAt - a.lastVisitAt || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
}

function parseCursor(value: unknown): BrowserHistoryCursor | null {
  if (value === null) return null
  const cursor = value as BrowserHistoryCursor
  if (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor.lastVisitAt) || typeof cursor.url !== 'string') {
    throw new Error('Invalid history cursor')
  }
  return { lastVisitAt: cursor.lastVisitAt, url: cursor.url }
}

function parseText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH) throw new Error('Invalid history query')
  return value.trim().toLowerCase()
}

/** 3: URL prefix, 2: every token starts a word, 1: every token is a substring, 0: no match. */
function matchTier(entry: BrowserHistoryEntry, text: string, tokens: string[]): number {
  const url = bareUrl(entry.url)
  const haystack = `${url} ${entry.title.toLowerCase()}`
  if (url.startsWith(bareUrl(text))) return 3
  if (tokens.every((token) => startsWord(haystack, token))) return 2
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0
}

interface HistoryState {
  entries: Map<string, BrowserHistoryEntry>
  /** Off pauses recording; what is already saved stays. */
  recording: boolean
  icons: Map<string, StoredIcon>
}

export class BrowserHistory {
  private state: HistoryState | null = null
  private loading: Promise<HistoryState> | null = null
  private listeners = new Set<() => void>()
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(private path: () => string, private now: () => number = Date.now) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** `typed`: the user entered it in the address bar; the commit may be the URL it redirected to. */
  async record(url: string, typed = false): Promise<void> {
    if (url.length > MAX_URL_LENGTH || !isBrowserUrl(url)) return
    const { entries, recording } = await this.load()
    if (!recording) return
    const now = this.now()
    const entry = entries.get(url)
    if (entry) {
      entry.lastVisitAt = now
      entry.visitCount++
      if (typed) entry.typedCount++
    } else {
      entries.set(url, { url, title: '', visitCount: 1, typedCount: typed ? 1 : 0, lastVisitAt: now })
      if (entries.size > MAX_ENTRIES) this.evict(entries, now)
    }
    this.changed()
  }

  /** Titles arrive after the commit; only pages already recorded take one. */
  async setTitle(url: string, title: string): Promise<void> {
    const { entries, recording } = await this.load()
    const entry = entries.get(url)
    const next = title.slice(0, MAX_TITLE_LENGTH)
    if (!recording) return
    if (!entry || entry.title === next) return
    entry.title = next
    this.changed()
  }

  /** Candidate icon URLs worth fetching for a recorded page; empty when its origin already has one of them. */
  async iconCandidates(url: string, icons: string[]): Promise<string[]> {
    const { entries, recording, icons: stored } = await this.load()
    const origin = originOf(url)
    if (!recording || !origin || !entries.has(url)) return []
    const candidates = icons.filter((icon) => icon.length <= MAX_URL_LENGTH && isBrowserUrl(icon)).slice(0, MAX_ICON_CANDIDATES)
    const current = stored.get(origin)?.source
    return current && candidates.includes(current) ? [] : candidates
  }

  /** `data` must already be a normalized PNG data URL; the page must still be recorded. */
  async setIcon(url: string, source: string, data: string): Promise<void> {
    if (!data.startsWith(ICON_PREFIX) || data.length > MAX_ICON_LENGTH || !isBrowserUrl(source)) throw new Error('Invalid browser history icon')
    const { entries, recording, icons } = await this.load()
    const origin = originOf(url)
    if (!recording || !origin || !entries.has(url)) return
    const current = icons.get(origin)
    if (current?.source === source && current.data === data) return
    icons.set(origin, { source, data })
    this.changed()
  }

  /** Most frecent sites, one tile each, showing that site's most frecent page. */
  async top(limit: unknown = 8): Promise<BrowserHistoryEntry[]> {
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RESULTS) throw new Error('Invalid history limit')
    const state = await this.load()
    const now = this.now()
    const best = new Map<string, { entry: BrowserHistoryEntry; score: number }>()
    for (const entry of state.entries.values()) {
      const site = siteOf(entry.url)
      const score = frecency(entry, now)
      const current = best.get(site)
      if (!current || score > current.score) best.set(site, { entry, score })
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score || b.entry.lastVisitAt - a.entry.lastVisitAt)
      .slice(0, limit as number)
      .map(({ entry }) => this.output(state, entry))
  }

  async query(text: unknown, limit: unknown = 8): Promise<BrowserHistoryEntry[]> {
    const needle = parseText(text)
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RESULTS) throw new Error('Invalid history limit')
    if (!needle) return []
    const tokens = needle.split(/\s+/)
    const now = this.now()
    const state = await this.load()
    return [...state.entries.values()]
      .map((entry) => ({ entry, tier: matchTier(entry, needle, tokens), score: frecency(entry, now) }))
      .filter((match) => match.tier > 0)
      .sort((a, b) => b.tier - a.tier || b.score - a.score || b.entry.lastVisitAt - a.entry.lastVisitAt)
      .slice(0, limit as number)
      .map(({ entry }) => this.output(state, entry))
  }

  /** Newest first, filtered by every whitespace-separated term appearing in the URL or title. */
  async list(text: unknown, cursor: unknown = null, limit: unknown = 50): Promise<BrowserHistoryPage> {
    const needle = parseText(text)
    const after = parseCursor(cursor)
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE) throw new Error('Invalid history limit')
    const tokens = needle ? needle.split(/\s+/) : []
    const state = await this.load()
    const matches = [...state.entries.values()]
      .filter((entry) => {
        if (after && byRecency(entry, { ...entry, ...after }) <= 0) return false
        const haystack = `${entry.url.toLowerCase()} ${entry.title.toLowerCase()}`
        return tokens.every((token) => haystack.includes(token))
      })
      .sort(byRecency)
    const entries = matches.slice(0, limit as number).map((entry) => this.output(state, entry))
    const last = entries.at(-1)
    return { entries, next: matches.length > entries.length && last ? { lastVisitAt: last.lastVisitAt, url: last.url } : null }
  }

  async remove(url: unknown): Promise<void> {
    if (typeof url !== 'string') throw new Error('Invalid history URL')
    if ((await this.load()).entries.delete(url)) this.changed()
  }

  async clear(): Promise<void> {
    const { entries, icons } = await this.load()
    if (!entries.size && !icons.size) return
    entries.clear()
    icons.clear()
    this.changed()
  }

  async isRecording(): Promise<boolean> {
    return (await this.load()).recording
  }

  async setRecording(enabled: unknown): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid history recording flag')
    const state = await this.load()
    if (state.recording === enabled) return
    state.recording = enabled
    this.changed()
  }

  /** Waits for pending changes, including mutations awaiting the first load, to reach disk. */
  async flush(): Promise<void> {
    // Earlier mutations resume from this same promise before flush inspects dirty state.
    await this.loading
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dirty) this.write()
    await this.writes
  }

  private output(state: HistoryState, entry: BrowserHistoryEntry): BrowserHistoryEntry {
    const icon = state.icons.get(originOf(entry.url)!)
    return icon ? { ...entry, icon: icon.data } : { ...entry }
  }

  private evict(entries: Map<string, BrowserHistoryEntry>, now: number): void {
    let lowest: BrowserHistoryEntry | null = null
    for (const entry of entries.values()) {
      if (!lowest || frecency(entry, now) < frecency(lowest, now)) lowest = entry
    }
    if (lowest) entries.delete(lowest.url)
  }

  private changed(): void {
    this.dirty = true
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.write()
    }, WRITE_DELAY_MS)
    for (const listener of this.listeners) listener()
  }

  private write(): void {
    const state = this.state
    if (!state) return
    this.dirty = false
    // Icons outlive their pages only until here; removal, eviction and clearing all end up written.
    const live = new Set([...state.entries.keys()].map((url) => originOf(url)))
    for (const origin of state.icons.keys()) if (!live.has(origin)) state.icons.delete(origin)
    const body = `${JSON.stringify({
      version: VERSION, recording: state.recording, entries: [...state.entries.values()], icons: Object.fromEntries(state.icons)
    })}\n`
    const run = this.writes.then(async () => {
      const path = this.path()
      const temporary = `${path}.${process.pid}.tmp`
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(temporary, body, { mode: 0o600 })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true }).catch(() => {})
      }
    })
    // A failed write leaves memory ahead of disk; the next change writes the whole list again.
    this.writes = run.catch((error) => {
      this.dirty = true
      console.error('Browser history write failed:', error)
    })
  }

  private load(): Promise<HistoryState> {
    if (this.state) return Promise.resolve(this.state)
    this.loading ??= this.read().then((state) => {
      this.state = state
      return state
    }, (error) => {
      this.loading = null
      throw error
    })
    return this.loading
  }

  private async read(): Promise<HistoryState> {
    let raw: string
    try { raw = await readFile(this.path(), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: new Map(), recording: true, icons: new Map() }
      throw error
    }
    const file = JSON.parse(raw) as { version?: unknown; recording?: unknown; entries?: unknown; icons?: unknown }
    if (!file || typeof file !== 'object' || file.version !== VERSION || !Array.isArray(file.entries) ||
      (file.recording !== undefined && typeof file.recording !== 'boolean')) {
      throw new Error('Invalid browser history file')
    }
    const entries = new Map<string, BrowserHistoryEntry>()
    for (const value of file.entries) {
      const entry = parseEntry(value)
      entries.set(entry.url, entry)
    }
    return { entries, recording: file.recording ?? true, icons: parseIcons(file.icons) }
  }
}

export const browserHistory = new BrowserHistory(() => pigPath('browser-history.json'))

export function flushBrowserHistory(): Promise<void> {
  return browserHistory.flush()
}

/** Only the path and query identify a page; a hash change alone is a jump within it. */
function samePage(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0]
}

function logFailure(error: unknown): void {
  console.error('Browser history update failed:', error)
}

/**
 * Turns page events into visits. Agent navigations count like any other, so the user can find what an
 * agent opened. A load started from the address bar marks its next document commit, after any redirects,
 * as typed; the mark ends with that load so an aborted one cannot leak onto a later click.
 */
export class BrowserHistoryRecorder implements BrowserPageEvents {
  private typed = new Map<string, object>()
  private committed = new Map<string, string>()
  private fetching = new Set<string>()
  private pendingIcons = new Map<string, { url: string; icons: string[] }>()
  /** Candidate lists that already failed for an origin; retried only after a restart or a different list. */
  private failed = new Map<string, string>()

  /** `fetchIcon` resolves a normalized PNG data URL, or null when the response is not a usable image. */
  constructor(private history: BrowserHistory, private fetchIcon?: (url: string) => Promise<string | null>) {}

  async typedNavigation(browserId: string, load: () => Promise<void>): Promise<void> {
    const token = {}
    this.typed.set(browserId, token)
    try { await load() } finally { if (this.typed.get(browserId) === token) this.typed.delete(browserId) }
  }

  commit(browserId: string, url: string, status: number | null): void {
    const previous = this.committed.get(browserId)
    this.committed.set(browserId, url)
    if (status === null) {
      if (previous === undefined || !samePage(previous, url)) void this.history.record(url).catch(logFailure)
      return
    }
    const typed = this.typed.delete(browserId)
    // Chromium reports error pages and non-HTTP commits without a positive status.
    if (status > 0) void this.history.record(url, typed).catch(logFailure)
  }

  title(_browserId: string, url: string, title: string): void {
    void this.history.setTitle(url, title).catch(logFailure)
  }

  icon(_browserId: string, url: string, icons: string[]): void {
    const origin = originOf(url)
    if (!this.fetchIcon || !origin) return
    this.pendingIcons.set(origin, { url, icons: [...icons] })
    if (!this.fetching.has(origin)) void this.loadIcon(origin).catch(logFailure)
  }

  private async loadIcon(origin: string): Promise<void> {
    this.fetching.add(origin)
    try {
      let request: { url: string; icons: string[] } | undefined
      while ((request = this.pendingIcons.get(origin))) {
        const { url, icons } = request
        const current = () => this.pendingIcons.get(origin) === request
        const candidates = await this.history.iconCandidates(url, icons)
        if (!current()) continue
        const key = candidates.join('\n')
        if (candidates.length && this.failed.get(origin) !== key) {
          let succeeded = false
          for (const candidate of candidates) {
            const data = await this.fetchIcon!(candidate).catch((error) => {
              console.warn('Browser favicon fetch failed:', error)
              return null
            })
            // A newer announcement supersedes both this result and its fallback candidates.
            if (!current()) break
            if (data) {
              this.failed.delete(origin)
              await this.history.setIcon(url, candidate, data)
              succeeded = true
              break
            }
          }
          if (current() && !succeeded) this.failed.set(origin, key)
        }
        if (current()) this.pendingIcons.delete(origin)
      }
    } finally {
      this.fetching.delete(origin)
    }
  }

  forget(browserId: string): void {
    this.typed.delete(browserId)
    this.committed.delete(browserId)
  }
}
