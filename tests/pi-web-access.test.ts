import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

interface FakeExtension {
  tools: string[]
  commands: string[]
  shortcuts: string[]
  events: string[]
}

async function loadPlugin(): Promise<FakeExtension> {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-access-plugin-'))
  process.env.PIG_DIR = root
  const plugin = await import('../src/main/plugins/pi-web-access/index.ts')
  const fake: FakeExtension = { tools: [], commands: [], shortcuts: [], events: [] }
  const api = {
    registerTool: (tool: { name: string }) => { fake.tools.push(tool.name) },
    registerCommand: (name: string) => { fake.commands.push(name) },
    registerShortcut: (_key: string, options: { description: string }) => { fake.shortcuts.push(options.description) },
    on: (event: string) => { fake.events.push(event) },
    appendEntry: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    getCommands: () => [],
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined
  } as unknown as ExtensionAPI
  plugin.default(api)
  return fake
}

test('the vendored plugin registers the four tools and no command surface', async () => {
  const fake = await loadPlugin()
  assert.deepEqual(fake.tools.sort(), ['fetch_content', 'get_search_content', 'source_check', 'web_search'])
  assert.deepEqual(fake.commands, [])
  assert.deepEqual(fake.shortcuts, [])
  assert.deepEqual(fake.events.sort(), ['session_shutdown', 'session_start', 'session_tree', 'tool_call'])
})

type ToolExecute = (callId: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ type: string; text?: string }> }>

interface FakeSession {
  tools: Map<string, ToolExecute>
  start: () => Promise<void>
  end: () => Promise<void>
}

function createSession(plugin: { default: (api: ExtensionAPI) => void }, branch: unknown[]): FakeSession {
  const tools: FakeSession['tools'] = new Map()
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
  const api = {
    registerTool: (tool: { name: string; execute: ToolExecute }) => { tools.set(tool.name, tool.execute) },
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
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
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'session' } }
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx)
  }
  return {
    tools,
    start: () => emit('session_start'),
    end: () => emit('session_shutdown')
  }
}

// The SDK caches the extension factory per cwd but runs it once per session, so tabs in the same
// worktree get separate factory closures. Results are held by reference count: one tab's session
// starting or ending must not drop or abort another tab's results.
test('one session starting or ending leaves another session\'s stored results in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-access-plugin-'))
  process.env.PIG_DIR = root
  const plugin = await import('../src/main/plugins/pi-web-access/index.ts')
  const data = {
    id: 'res-a',
    type: 'fetch',
    timestamp: Date.now(),
    urls: [{ url: 'https://example.org', title: 'Example', content: 'hello from session A', error: null }]
  }
  const sessionA = createSession(plugin, [{ type: 'custom', customType: 'web-search-results', data }])
  const sessionB = createSession(plugin, [])
  await sessionA.start()
  await sessionB.start()
  const readA = sessionA.tools.get('get_search_content')
  assert.ok(readA)
  const kept = await readA('call', { responseId: 'res-a', urlIndex: 0 })
  assert.match(kept.content?.[0]?.text ?? '', /hello from session A/)

  // Session B ends while A is mid-turn; A still holds the result.
  await sessionB.end()
  const afterB = await readA('call', { responseId: 'res-a', urlIndex: 0 })
  assert.match(afterB.content?.[0]?.text ?? '', /hello from session A/)

  // A session forked from A's history shares the id and keeps it alive after A ends.
  const sessionC = createSession(plugin, [{ type: 'custom', customType: 'web-search-results', data }])
  await sessionC.start()
  await sessionA.end()
  const readC = sessionC.tools.get('get_search_content')
  assert.ok(readC)
  const shared = await readC('call', { responseId: 'res-a', urlIndex: 0 })
  assert.match(shared.content?.[0]?.text ?? '', /hello from session A/)
  await sessionC.end()
})

// A reload evaluates the module again; the installed global fetch wrapper must still see the proxy
// scope of the new instance, or requests after a reload silently bypass the configured proxy.
test('a reloaded module instance shares the proxy scope with the installed wrapper', async () => {
  const first = await import('../src/main/plugins/pi-web-access/utils.ts')
  // The query string is what forces a second evaluation of the module; TypeScript cannot resolve it.
  const reloadSpecifier = '../src/main/plugins/pi-web-access/utils.ts?reload=1'
  const reloaded = (await import(reloadSpecifier)) as typeof first
  assert.notEqual(reloaded.getActiveProxy, first.getActiveProxy, 'the query creates a second module instance')
  const nativeFetch = globalThis.fetch
  try {
    const seen = reloaded.runWithProxy('http://proxy.example:8080', () => first.getActiveProxy())
    assert.equal(seen, 'http://proxy.example:8080/')
  } finally {
    globalThis.fetch = nativeFetch
  }
})
