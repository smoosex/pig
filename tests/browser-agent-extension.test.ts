import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserAgentHost } from '../src/main/plugins/pig-browser-host'

test('the jiti-loaded browser tools forward the session to the host registered by main', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-browser-ext-'))
  const previousPig = process.env.PIG_DIR
  const previousPi = process.env.PI_CODING_AGENT_DIR
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  try {
    const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
    const { registerBrowserAgentHost } = await import('../src/main/plugins/pig-browser-host')
    const path = join(process.cwd(), 'src', 'main', 'plugins', 'pig-browser', 'index.ts')
    const loader = await createNoExtensionsResourceLoader(root, [path])
    expect(loader.getExtensions().errors).toEqual([])
    const extension = loader.getExtensions().extensions.find((item) => item.path === path)!
    expect([...extension.tools.keys()].sort()).toEqual([
      'browser_annotations', 'browser_click', 'browser_console', 'browser_history', 'browser_navigate', 'browser_open', 'browser_press', 'browser_screenshot', 'browser_scroll', 'browser_select', 'browser_snapshot', 'browser_tabs', 'browser_type', 'browser_wait'
    ])
    const tool = (name: string) => extension.tools.get(name)!.definition
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'session-1' } }
    const controller = new AbortController()
    await expect(tool('browser_tabs').execute('c0', {}, controller.signal, undefined, ctx as never)).rejects.toThrow('unavailable')

    const calls: unknown[][] = []
    const text = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return { text: name } }
    registerBrowserAgentHost({
      tabs: text('tabs'), open: text('open'), navigate: text('navigate'), history: text('history'),
      snapshot: text('snapshot'), console: text('console'), annotations: text('annotations'), interact: text('interact'), wait: text('wait'),
      screenshot: async (...args) => { calls.push(['screenshot', ...args]); return { text: 'shot', image: { data: 'PNG', mimeType: 'image/png' } } }
    } satisfies BrowserAgentHost)
    await tool('browser_open').execute('c1', { url: 'http://localhost:3000' }, controller.signal, undefined, ctx as never)
    await tool('browser_history').execute('c2', { action: 'reload' }, controller.signal, undefined, ctx as never)
    await tool('browser_console').execute('c3', {}, controller.signal, undefined, ctx as never)
    expect(calls).toEqual([
      ['open', 'session-1', { browserId: undefined, url: 'http://localhost:3000' }, controller.signal],
      ['history', 'session-1', 'reload', controller.signal],
      ['console', 'session-1', false]
    ])
    expect(await tool('browser_screenshot').execute('c4', {}, controller.signal, undefined, ctx as never)).toEqual({
      content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'PNG', mimeType: 'image/png' }], details: undefined
    })
    calls.length = 0
    await tool('browser_click').execute('c5', { ref: 'e1' }, controller.signal, undefined, ctx as never)
    await tool('browser_type').execute('c6', { ref: 'e2', text: 'hello' }, controller.signal, undefined, ctx as never)
    await tool('browser_press').execute('c7', { key: 'Enter' }, controller.signal, undefined, ctx as never)
    await tool('browser_scroll').execute('c8', { deltaY: 400 }, controller.signal, undefined, ctx as never)
    await tool('browser_select').execute('c9', { ref: 'e3', values: ['pro'] }, controller.signal, undefined, ctx as never)
    await tool('browser_wait').execute('c10', { selector: '#ready', state: 'visible' }, controller.signal, undefined, ctx as never)
    expect(calls).toEqual([
      ['interact', 'session-1', { action: 'click', ref: 'e1' }, controller.signal],
      ['interact', 'session-1', { action: 'type', ref: 'e2', text: 'hello', replace: true }, controller.signal],
      ['interact', 'session-1', { action: 'press', key: 'Enter', ref: undefined }, controller.signal],
      ['interact', 'session-1', { action: 'scroll', deltaY: 400, deltaX: undefined, ref: undefined }, controller.signal],
      ['interact', 'session-1', { action: 'select', ref: 'e3', values: ['pro'] }, controller.signal],
      ['wait', 'session-1', { selector: '#ready', state: 'visible' }, controller.signal]
    ])
    for (const { definition } of extension.tools.values()) {
      expect(definition.exposure).toBe('deferred')
      expect(definition.namespace?.name).toBe('browser')
      expect(definition.promptGuidelines).toBeUndefined()
    }
    expect(tool('browser_tabs').namespace?.instructions).toContain('untrusted')
    expect(tool('browser_snapshot').description).toContain('untrusted')
    registerBrowserAgentHost(undefined)
  } finally {
    if (previousPig === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previousPig
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousPi
    await rm(root, { recursive: true, force: true })
  }
})
