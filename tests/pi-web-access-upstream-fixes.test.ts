import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { storeFetchedContentResult, clearResults } from '../src/main/plugins/pi-web-access/storage'

/**
 * Regression cover for the upstream fixes this fork carries. These drive the real tools with
 * stored content instead of a network, so they stay deterministic.
 */

type ToolExecute = (callId: string, params: Record<string, unknown>) => Promise<{
  content?: Array<{ type: string; text?: string }>
  details?: Record<string, unknown>
  isError?: boolean
}>

async function fixture(): Promise<Map<string, ToolExecute>> {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-access-fixes-'))
  process.env.PIG_DIR = root
  await mkdir(root, { recursive: true })
  const { mock } = await import('bun:test')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const plugin = await import('../src/main/plugins/pi-web-access/index.ts')
  const tools = new Map<string, ToolExecute>()
  const api = {
    registerTool: (tool: { name: string; execute: ToolExecute }) => { tools.set(tool.name, tool.execute) },
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    getCommands: () => [],
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined
  }
  plugin.default(api as unknown as ExtensionAPI)
  return tools
}

/** True when no surrogate pair is split at either end of the slice. */
function hasWholePairs(slice: string): boolean {
  const first = slice.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) return false
  const last = slice.charCodeAt(slice.length - 1)
  return !(last >= 0xd800 && last <= 0xdbff)
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n')
}

test('get_search_content pages never split an emoji across two pages', async () => {
  const tools = await fixture()
  const getContent = tools.get('get_search_content')
  assert.ok(getContent)
  const content = `PAYLOAD${'😀'.repeat(6)}end`
  storeFetchedContentResult('emoji-fetch', {
    id: 'emoji-fetch',
    type: 'fetch',
    timestamp: Date.now(),
    urls: [{ url: 'https://example.org/emoji', title: 'Emoji', content, error: null }]
  })
  try {
    for (const limit of [1, 2, 3]) {
      const pages: string[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const result = await getContent('call', { responseId: 'emoji-fetch', urlIndex: 0, offset, limit })
        const text = textOf(result)
        const returned = Number(result.details?.returnedChars ?? 0)
        // Every page repeats the "# <title>\n\n" header; the payload follows it.
        const start = text.indexOf('\n\n') + 2
        assert.ok(start >= 2, `page at offset ${offset} has no header`)
        const slice = text.slice(start, start + returned)
        assert.ok(hasWholePairs(slice), `split surrogate pair at offset ${offset} with limit ${limit}: ${JSON.stringify(slice)}`)
        pages.push(slice)
        offset = (result.details?.nextOffset ?? null) as number | null
      }
      assert.equal(pages.join(''), content)
    }
  } finally {
    clearResults()
  }
})

test('get_search_content findText excerpts keep whole characters', async () => {
  const tools = await fixture()
  const getContent = tools.get('get_search_content')
  assert.ok(getContent)
  const content = `prefix ${'🎉'.repeat(3)} suffix`
  storeFetchedContentResult('find-fetch', {
    id: 'find-fetch',
    type: 'fetch',
    timestamp: Date.now(),
    urls: [{ url: 'https://example.org/find', title: 'Find', content, error: null }]
  })
  try {
    const result = await getContent('call', { responseId: 'find-fetch', urlIndex: 0, findText: 'suffix' })
    const text = textOf(result)
    assert.doesNotMatch(text, /\uFFFD/)
    assert.match(text, /suffix/)
  } finally {
    clearResults()
  }
})

test('a failed tool call is marked as an error result', async () => {
  const tools = await fixture()
  const fetchContent = tools.get('fetch_content')
  assert.ok(fetchContent)
  // No URL at all: nothing succeeded, so the result has to carry isError for the UI and codemode.
  const result = await fetchContent('call', {})
  assert.equal(result.isError, true, 'a call where nothing succeeded is an error result')
})

test('a search result stored under one id is retrievable without url or urlIndex', async () => {
  const tools = await fixture()
  const getContent = tools.get('get_search_content')
  assert.ok(getContent)
  storeFetchedContentResult('single-fetch', {
    id: 'single-fetch',
    type: 'fetch',
    timestamp: Date.now(),
    urls: [{ url: 'https://example.org/only', title: 'Only', content: 'the only stored page', error: null }]
  })
  try {
    const result = await getContent('call', { responseId: 'single-fetch' })
    assert.match(textOf(result), /the only stored page/)
  } finally {
    clearResults()
  }
})
