/** Global browser history: dedupe, ranking, eviction, strict persistence and page-event mapping. */
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({ app: { isPackaged: false } }))
const { BrowserHistory, BrowserHistoryRecorder } = await import('../src/main/browser/history')

const DAY = 24 * 60 * 60 * 1000
const dirs: string[] = []

async function fixture(start = 10 * DAY) {
  const dir = await mkdtemp(join(tmpdir(), 'pig-history-'))
  dirs.push(dir)
  const path = join(dir, 'browser-history.json')
  const clock = { now: start }
  return { path, clock, history: new BrowserHistory(() => path, () => clock.now) }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('visits dedupe by URL, titles attach to recorded pages only, and only HTTP(S) is kept', async () => {
  const { history, clock } = await fixture()
  await history.record('https://example.com/a')
  clock.now += 1000
  await history.record('https://example.com/a', true)
  await history.setTitle('https://example.com/a', 'Example A')
  await history.setTitle('https://example.com/unseen', 'Ignored')
  await history.record('file:///etc/passwd')
  await history.record('https://user:pass@example.com/')
  expect(await history.query('example', 20)).toEqual([
    { url: 'https://example.com/a', title: 'Example A', visitCount: 2, typedCount: 1, lastVisitAt: clock.now }
  ])
})

test('URL prefix beats word starts beats substrings; frecency orders within a tier', async () => {
  const { history, clock } = await fixture()
  await history.record('https://docs.example.com/guide')
  await history.setTitle('https://docs.example.com/guide', 'Getting started')
  await history.record('https://www.github.com/pig')
  for (const url of ['https://example.org/github-mirror', 'https://example.org/agithubx']) await history.record(url)
  await history.record('https://example.org/github-mirror')
  clock.now += 30 * DAY
  expect((await history.query('github', 20)).map((entry) => entry.url)).toEqual([
    'https://www.github.com/pig', 'https://example.org/github-mirror', 'https://example.org/agithubx'
  ])
  expect((await history.query('start docs', 20)).map((entry) => entry.url)).toEqual(['https://docs.example.com/guide'])
  expect(await history.query('   ', 5)).toEqual([])
  await expect(history.query('x', 0)).rejects.toThrow(/limit/)
  await expect(history.query(1 as unknown as string)).rejects.toThrow(/query/)
})

test('a full history evicts the least frecent page', async () => {
  const { history, clock } = await fixture()
  await history.record('https://old.test/')
  clock.now += 60 * DAY
  for (let i = 0; i < 2000; i++) await history.record(`https://site${i}.test/`)
  expect(await history.query('old.test', 5)).toEqual([])
  expect(await history.query('site0.test', 5)).toHaveLength(1)
})

test('changes persist atomically with owner-only permissions and survive a reload', async () => {
  const { history, path } = await fixture()
  await history.record('https://example.com/', true)
  await history.record('https://example.com/gone')
  await history.remove('https://example.com/gone')
  await history.flush()
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const reloaded = new BrowserHistory(() => path)
  expect((await reloaded.query('example', 5)).map((entry) => entry.url)).toEqual(['https://example.com/'])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('flush waits for mutations already waiting on the first load', async () => {
  const { history, path } = await fixture()
  const gate = deferred<void>()
  const reader = history as unknown as { read(): Promise<unknown> }
  const read = reader.read.bind(history)
  const delayed = spyOn(reader, 'read').mockImplementation(async () => {
    await gate.promise
    return read()
  })
  try {
    const record = history.record('https://example.com/', true)
    const title = history.setTitle('https://example.com/', 'Loaded title')
    let flushed = false
    const flush = history.flush().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    gate.resolve()
    await flush
    await Promise.all([record, title])
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.entries).toEqual([expect.objectContaining({ url: 'https://example.com/', title: 'Loaded title', typedCount: 1 })])
  } finally {
    delayed.mockRestore()
  }
})

test('flush propagates a pending first-load failure without overwriting the file', async () => {
  const { history, path } = await fixture()
  await writeFile(path, 'broken JSON')
  const gate = deferred<void>()
  const reader = history as unknown as { read(): Promise<unknown> }
  const read = reader.read.bind(history)
  const delayed = spyOn(reader, 'read').mockImplementation(async () => {
    await gate.promise
    return read()
  })
  try {
    const mutation = history.record('https://example.com/')
    const flush = history.flush()
    const results = Promise.allSettled([mutation, flush])
    gate.resolve()
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.any(SyntaxError) },
      { status: 'rejected', reason: expect.any(SyntaxError) }
    ])
    expect(await readFile(path, 'utf8')).toBe('broken JSON')
  } finally {
    delayed.mockRestore()
  }
})

test('an unreadable file is reported and never overwritten', async () => {
  const { history, path } = await fixture()
  await writeFile(path, '{"version":1,"entries":[{"url":"javascript:1"}]}')
  await expect(history.record('https://example.com/')).rejects.toThrow(/Invalid/)
  await expect(history.query('example')).rejects.toThrow(/Invalid/)
  await history.flush()
  expect(await readFile(path, 'utf8')).toBe('{"version":1,"entries":[{"url":"javascript:1"}]}')
})

test('page events: typed loads, hash jumps and error pages', async () => {
  const { history } = await fixture()
  const visits = new BrowserHistoryRecorder(history)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  await visits.typedNavigation('b', async () => { visits.commit('b', 'https://example.com/landing', 200) })
  visits.commit('b', 'https://example.com/landing#section', null)
  visits.commit('b', 'https://example.com/spa-route', null)
  visits.commit('b', 'https://example.com/failed', 0)
  // An aborted typed load must not mark the next ordinary commit.
  await visits.typedNavigation('b', async () => {})
  visits.commit('b', 'https://example.com/clicked', 200)
  visits.title('b', 'https://example.com/clicked', 'Clicked')
  await settle()
  expect((await history.query('example.com', 20)).map(({ url, typedCount, title }) => ({ url, typedCount, title }))).toEqual([
    { url: 'https://example.com/landing', typedCount: 1, title: '' },
    { url: 'https://example.com/spa-route', typedCount: 0, title: '' },
    { url: 'https://example.com/clicked', typedCount: 0, title: 'Clicked' }
  ])
})

test('the list pages newest first with a stable cursor and filters by every term', async () => {
  const { history, clock } = await fixture()
  for (const url of ['https://a.test/', 'https://b.test/', 'https://c.test/docs']) {
    await history.record(url)
  }
  // Same timestamp for the last two: the URL decides their order and the cursor must not skip or repeat.
  clock.now += 1000
  await history.record('https://e.test/')
  await history.record('https://d.test/docs')
  await history.setTitle('https://d.test/docs', 'Reference Docs')
  const first = await history.list('', null, 2)
  expect(first.entries.map((entry) => entry.url)).toEqual(['https://d.test/docs', 'https://e.test/'])
  const second = await history.list('', first.next, 2)
  expect(second.entries.map((entry) => entry.url)).toEqual(['https://a.test/', 'https://b.test/'])
  const third = await history.list('', second.next, 2)
  expect(third).toEqual({ entries: [expect.objectContaining({ url: 'https://c.test/docs' })], next: null })
  expect((await history.list('docs reference', null, 10)).entries.map((entry) => entry.url)).toEqual(['https://d.test/docs'])
  await expect(history.list('', { lastVisitAt: 'x' }, 10)).rejects.toThrow(/cursor/)
  await expect(history.list('', null, 101)).rejects.toThrow(/limit/)
})

test('pausing keeps saved pages, stops new visits and titles, and survives a reload; clearing empties', async () => {
  const { history, path } = await fixture()
  const changes: number[] = []
  history.onChange(() => changes.push(changes.length))
  await history.record('https://kept.test/')
  await history.setRecording(false)
  await history.record('https://paused.test/')
  await history.setTitle('https://kept.test/', 'Late title')
  await history.flush()
  const reloaded = new BrowserHistory(() => path)
  expect(await reloaded.isRecording()).toBe(false)
  expect((await reloaded.list('', null, 10)).entries.map(({ url, title }) => ({ url, title }))).toEqual([{ url: 'https://kept.test/', title: '' }])
  await reloaded.setRecording(true)
  await reloaded.clear()
  expect((await reloaded.list('', null, 10)).entries).toEqual([])
  expect(changes).toHaveLength(2)
  await expect(history.setRecording('no')).rejects.toThrow(/flag/)
})

const PNG = 'data:image/png;base64,iVBORw0KGgo='

test('top sites keep one most frecent page per site, www. included', async () => {
  const { history } = await fixture()
  await history.record('https://www.github.com/a')
  await history.record('https://github.com/b', true)
  await history.record('https://docs.test/')
  await history.record('http://localhost:3000/')
  await history.record('http://localhost:3000/')
  expect((await history.top(8)).map((entry) => entry.url)).toEqual(['https://github.com/b', 'http://localhost:3000/', 'https://docs.test/'])
  expect((await history.top(1)).map((entry) => entry.url)).toEqual(['https://github.com/b'])
  await expect(history.top(0)).rejects.toThrow(/limit/)
})

test('favicons are fetched once per origin, shown on its pages, and leave with the last page', async () => {
  const { history, path } = await fixture()
  const fetched: string[] = []
  const recorder = new BrowserHistoryRecorder(history, async (url) => {
    fetched.push(url)
    return url.endsWith('.svg') ? null : PNG
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  await history.record('https://a.test/one')
  await history.record('https://a.test/two')
  recorder.icon('b', 'https://a.test/one', ['https://a.test/icon.svg', 'https://a.test/icon.png', 'file:///icon.png'])
  await settle()
  expect(fetched).toEqual(['https://a.test/icon.svg', 'https://a.test/icon.png'])
  recorder.icon('b', 'https://a.test/two', ['https://a.test/icon.svg', 'https://a.test/icon.png'])
  recorder.icon('b', 'https://unrecorded.test/', ['https://unrecorded.test/favicon.ico'])
  await settle()
  expect(fetched).toHaveLength(2)
  expect((await history.query('a.test', 10)).map((entry) => entry.icon)).toEqual([PNG, PNG])
  await expect(history.setIcon('https://a.test/one', 'https://a.test/x', 'data:image/svg+xml,<svg/>')).rejects.toThrow(/icon/)

  await history.flush()
  const reloaded = new BrowserHistory(() => path)
  expect((await reloaded.top(1))[0]?.icon).toBe(PNG)
  await reloaded.remove('https://a.test/one')
  await reloaded.remove('https://a.test/two')
  await reloaded.flush()
  expect(JSON.parse(await readFile(path, 'utf8')).icons).toEqual({})
})

test('favicon fetches serialize per origin, retain only the latest candidates and discard stale results', async () => {
  const { history, path } = await fixture()
  await history.record('https://a.test/one')
  await history.record('https://a.test/two')
  const old = deferred<string | null>()
  const latest = deferred<string | null>()
  const started = deferred<void>()
  const nextStarted = deferred<void>()
  const fetched: string[] = []
  const recorder = new BrowserHistoryRecorder(history, (url) => {
    fetched.push(url)
    if (url.endsWith('/old.png')) {
      started.resolve()
      return old.promise
    }
    nextStarted.resolve()
    return latest.promise
  })
  recorder.icon('b1', 'https://a.test/one', ['https://a.test/old.png', 'https://a.test/fallback.png'])
  await started.promise
  recorder.icon('b2', 'https://a.test/two', ['https://a.test/intermediate.png'])
  recorder.icon('b2', 'https://a.test/two', ['https://a.test/latest.png'])
  expect(fetched).toEqual(['https://a.test/old.png'])
  old.resolve(PNG)
  await nextStarted.promise
  expect(fetched).toEqual(['https://a.test/old.png', 'https://a.test/latest.png'])
  expect((await history.top(1))[0]?.icon).toBeUndefined()
  const changed = deferred<void>()
  const unsubscribe = history.onChange(() => changed.resolve())
  latest.resolve(`${PNG}latest`)
  await changed.promise
  unsubscribe()
  await history.flush()
  expect(JSON.parse(await readFile(path, 'utf8')).icons['https://a.test']).toEqual({
    source: 'https://a.test/latest.png', data: `${PNG}latest`
  })
})

test('an origin whose icons all failed is not refetched for the same list', async () => {
  const { history } = await fixture()
  let calls = 0
  const recorder = new BrowserHistoryRecorder(history, async () => { calls++; throw new Error('offline') })
  const warn = console.warn
  console.warn = () => {}
  try {
    await history.record('https://a.test/')
    recorder.icon('b', 'https://a.test/', ['https://a.test/favicon.ico'])
    await new Promise((resolve) => setTimeout(resolve, 10))
    recorder.icon('b', 'https://a.test/', ['https://a.test/favicon.ico'])
    await new Promise((resolve) => setTimeout(resolve, 10))
  } finally {
    console.warn = warn
  }
  expect(calls).toBe(1)
})
