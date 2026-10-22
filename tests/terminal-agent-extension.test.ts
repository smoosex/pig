/** Verify the actual jiti extension shares main's registry without leaking module mocks to other suites. */
import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalAgentHost } from '../src/main/plugins/pig-terminal-host'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-terminal-extension-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  try {
    const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
    const { registerTerminalAgentHost } = await import('../src/main/plugins/pig-terminal-host')
    const path = join(process.cwd(), 'src/main/plugins/pig-terminal/index.ts')
    const loader = await createNoExtensionsResourceLoader(root, [path])
    expect(loader.getExtensions().errors).toEqual([])
    const extension = loader.getExtensions().extensions.find(item => item.path === path)!
    expect([...extension.tools.keys()].sort()).toEqual(['terminal_close', 'terminal_open', 'terminal_press', 'terminal_read', 'terminal_release', 'terminal_switch', 'terminal_tabs', 'terminal_type', 'terminal_wait'])
    const tool = (name: string) => extension.tools.get(name)!.definition
    const ctx = { sessionManager: { getSessionId: () => 'session-1' } }
    const signal = new AbortController().signal
    await expect(tool('terminal_tabs').execute('0', {}, signal, undefined, ctx as never)).rejects.toThrow('unavailable')
    const calls: unknown[][] = []
    const forward = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return { text: name } }
    registerTerminalAgentHost({ tabs: forward('tabs'), open: forward('open'), read: forward('read'), type: forward('type'), press: forward('press'), release: forward('release'), wait: forward('wait'), switchTab: forward('switch'), close: forward('close'), sessionClosed() {} } satisfies TerminalAgentHost)
    await tool('terminal_tabs').execute('1', {}, signal, undefined, ctx as never)
    await tool('terminal_open').execute('2', { terminalId: 'terminal:user' }, signal, undefined, ctx as never)
    await tool('terminal_read').execute('3', {}, signal, undefined, ctx as never)
    await tool('terminal_type').execute('4', { text: 'hello' }, signal, undefined, ctx as never)
    await tool('terminal_press').execute('5', { key: 'Ctrl+C' }, signal, undefined, ctx as never)
    await tool('terminal_release').execute('6', {}, signal, undefined, ctx as never)
    await tool('terminal_wait').execute('7', { afterVersion: 2, idleMs: 500 }, signal, undefined, ctx as never)
    await tool('terminal_switch').execute('8', { terminalId: 'terminal:other' }, signal, undefined, ctx as never)
    await tool('terminal_close').execute('9', {}, signal, undefined, ctx as never)
    expect(calls).toEqual([
      ['tabs', 'session-1'], ['open', 'session-1', 'terminal:user', signal], ['read', 'session-1', 100, signal],
      ['type', 'session-1', 'hello', false, signal], ['press', 'session-1', 'Ctrl+C', signal], ['release', 'session-1'],
      ['wait', 'session-1', { afterVersion: 2, idleMs: 500 }, signal], ['switch', 'session-1', 'terminal:other', false, signal], ['close', 'session-1', signal]
    ])
    for (const { definition } of extension.tools.values()) {
      expect(definition.exposure).toBe('deferred')
      expect(definition.namespace?.name).toBe('terminal')
      expect(definition.promptGuidelines).toBeUndefined()
      expect(definition.promptSnippet).toBeUndefined()
    }
    expect(tool('terminal_read').namespace?.instructions).toContain('untrusted')
    registerTerminalAgentHost(undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (process.argv.includes('--terminal-extension-fixture')) await fixture()
else test('jiti terminal tools are deferred and forward only the calling session to main', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--terminal-extension-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err || out).toBe(0)
}, 30_000)
