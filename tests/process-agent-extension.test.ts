/** Verify the actual jiti extension shares main's registry without leaking module mocks to other suites. */
import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessAgentHost } from '../src/main/plugins/pig-process-host'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-process-extension-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  try {
    const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
    const { registerProcessAgentHost } = await import('../src/main/plugins/pig-process-host')
    const path = join(process.cwd(), 'src/main/plugins/pig-process/index.ts')
    const loader = await createNoExtensionsResourceLoader(root, [path])
    expect(loader.getExtensions().errors).toEqual([])
    const extension = loader.getExtensions().extensions.find(item => item.path === path)!
    expect([...extension.tools.keys()].sort()).toEqual(['process_list', 'process_read', 'process_start', 'process_stop', 'process_wait'])
    const tool = (name: string) => extension.tools.get(name)!.definition
    const ctx = { sessionManager: { getSessionId: () => 'session-1' } }
    const signal = new AbortController().signal
    await expect(tool('process_list').execute('0', {}, signal, undefined, ctx as never)).rejects.toThrow('unavailable')
    const calls: unknown[][] = []
    const forward = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return { text: name } }
    registerProcessAgentHost({ start: forward('start'), list: forward('list'), read: forward('read'), wait: forward('wait'), stop: forward('stop'),
      attach: (...args: unknown[]) => { calls.push(['attach', ...args]) }, detach: (...args: unknown[]) => { calls.push(['detach', ...args]) }
    } satisfies ProcessAgentHost)
    await extension.handlers.get('session_start')![0]({ type: 'session_start' } as never, ctx as never)
    await extension.handlers.get('session_shutdown')![0]({ type: 'session_shutdown' } as never, ctx as never)
    const [[, attached, deliver], [, detached, undelivered]] = calls.splice(0) as [string, string, unknown][]
    expect([attached, detached]).toEqual(['session-1', 'session-1'])
    expect(undelivered).toBe(deliver)
    await tool('process_start').execute('1', { command: 'bun dev', name: 'dev' }, signal, undefined, ctx as never)
    await tool('process_list').execute('2', {}, signal, undefined, ctx as never)
    await tool('process_read').execute('3', { processId: 'proc-1' }, signal, undefined, ctx as never)
    await tool('process_wait').execute('4', { processId: 'proc-1', text: 'ready', afterVersion: 2 }, signal, undefined, ctx as never)
    await expect(tool('process_wait').execute('5', { processId: 'proc-1', text: 'a\nb' }, signal, undefined, ctx as never)).rejects.toThrow('single line')
    await tool('process_stop').execute('6', { processId: 'proc-1' }, signal, undefined, ctx as never)
    expect(calls).toEqual([
      ['start', 'session-1', 'bun dev', { cwd: undefined, name: 'dev' }, signal], ['list', 'session-1'], ['read', 'session-1', 'proc-1', 100],
      ['wait', 'session-1', 'proc-1', { text: 'ready', afterVersion: 2 }, signal], ['stop', 'session-1', 'proc-1']
    ])
    for (const { definition } of extension.tools.values()) {
      expect(definition.exposure).toBe('deferred')
      expect(definition.namespace?.name).toBe('process')
      expect(definition.promptGuidelines).toBeUndefined()
      expect(definition.promptSnippet).toBeUndefined()
    }
    expect(tool('process_start').namespace?.instructions).toContain('untrusted')
    registerProcessAgentHost(undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (process.argv.includes('--process-extension-fixture')) await fixture()
else test('jiti process tools are deferred and forward only the calling session to main', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--process-extension-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, err || out).toBe(0)
}, 30_000)
