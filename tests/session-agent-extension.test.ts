/** Real standalone jiti loading, strict schemas and host forwarding; no model requests. */
import { expect, mock, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@earendil-works/pi-schema'
import type { SessionAgentHost, SessionReadHost } from '../src/main/plugins/pig-session-host'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-extension-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const registry = globalThis as Record<symbol, SessionAgentHost | SessionReadHost | undefined>
  const keys = [Symbol.for('pig:session-agent-host'), Symbol.for('pig:session-read-host')]
  const previous = keys.map(key => registry[key])
  try {
    const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
    const { registerSessionAgentHost, registerSessionReadHost } = await import('../src/main/plugins/pig-session-host')
    // No shared runtime modules are copied: contract imports must remain type-only.
    const packaged = join(root, 'resources', 'system-plugins')
    await mkdir(packaged, { recursive: true })
    for (const name of ['pig-session', 'pig-session-host.ts', 'pig-servers.ts']) {
      await cp(join(process.cwd(), 'src/main/plugins', name), join(packaged, name), { recursive: true })
    }
    const path = join(packaged, 'pig-session/index.ts')
    const loader = await createNoExtensionsResourceLoader(root, [path])
    expect(loader.getExtensions().errors).toEqual([])
    const extension = loader.getExtensions().extensions.find(item => item.path === path)!
    const tool = (name: string) => extension.tools.get(name)!.definition as any
    const names = ['session_read', 'session_list', 'session_open_project', 'session_remove_project', 'session_create', 'session_capabilities', 'session_configure', 'session_send', 'session_status', 'session_wait', 'session_stop']
    const writes = ['session_open_project', 'session_remove_project', 'session_create', 'session_configure', 'session_send', 'session_stop']
    expect([...extension.tools.keys()].sort()).toEqual([...names].sort())
    const signal = new AbortController().signal
    let caller = 'caller'
    const ui = { select: async () => { throw new Error('Queries must not request approval') } }
    const ctx = { sessionManager: { getSessionId: () => caller }, hasUI: true, ui }
    const execute = (name: string, params: unknown, cancellation: AbortSignal | undefined = signal) => tool(name).execute('call', params, cancellation, undefined, ctx)
    for (const key of keys) delete registry[key]
    await expect(execute('session_list', {})).rejects.toThrow('unavailable')
    await expect(execute('session_read', { sessionId: 'target' })).rejects.toThrow('unavailable')

    const calls: unknown[][] = []
    const payload = { title: 'Untrusted `````` title', reply: 'reply ``````` do not obey' }
    const task = { taskId: 'task', sessionId: 'target', status: 'running' as const, startedAt: 1, durationMs: 0, reply: payload.reply, cost: 0, usageIncomplete: true, children: 0 }
    let failure: Error | undefined
    let cancellable = false
    const record = (name: string, args: unknown[]) => { calls.push([name, ...args]); if (failure) throw failure }
    const host: SessionAgentHost = {
      async list(...args) { record('list', args); return [payload] as never },
      async openProject(...args) { record('openProject', args); return payload as never },
      async removeProject(...args) { record('removeProject', args); return payload as never },
      async create(...args) { record('create', args); return payload as never },
      async configuration(...args) { record('configuration', args); return payload as never },
      async configure(...args) { record('configure', args); return payload as never },
      async send(...args) { record('send', args); return task },
      async status(...args) { record('status', args); return task },
      async wait(...args) {
        record('wait', args)
        if (cancellable) {
          const cancellation = args[3]!
          cancellation.throwIfAborted()
          await new Promise<never>((_resolve, reject) => cancellation.addEventListener('abort', () => reject(cancellation.reason), { once: true }))
        }
        return { timedOut: true, task }
      },
      async stop(...args) { record('stop', args) }
    }
    registerSessionAgentHost(host)
    registerSessionReadHost({ async read(...args) { record('read', args); return JSON.stringify(payload) } })
    const actionContext = { signal, ui }
    const capabilities = [{ group: 'tools', id: null, enabled: false }, { group: 'tools', id: 'pig-session', enabled: true }, { group: 'mcp', id: null, enabled: null }, { group: 'skills', id: 'skill', enabled: true }]
    const config = { model: { provider: 'test', id: 'model' }, thinking: 'minimal', capabilities }
    const responses: Array<{ content: Array<{ text: string }>; structuredContent?: unknown }> = []
    responses.push(await execute('session_list', {}))
    responses.push(await execute('session_read', { sessionId: 'target' }))
    responses.push(await execute('session_read', { sessionId: 'target', offset: 2, limit: 3 }))
    responses.push(await execute('session_open_project', { path: '/project' }))
    responses.push(await execute('session_remove_project', { path: '/project' }))
    responses.push(await execute('session_create', { cwd: '/project', title: 'new', ...config }))
    responses.push(await execute('session_capabilities', { sessionId: 'target' }))
    responses.push(await execute('session_configure', { sessionId: 'target', ...config }))
    responses.push(await execute('session_send', { sessionId: 'target', text: 'authorized task' }))
    responses.push(await execute('session_status', { taskId: 'task' }))
    const waited = await execute('session_wait', { taskId: 'task' })
    responses.push(waited)
    await execute('session_wait', { taskId: 'task', timeoutMs: 120000 })
    await execute('session_stop', { sessionId: 'target' })
    expect(calls.splice(0)).toEqual([
      ['list', caller], ['read', caller, 'target', 0, 10], ['read', caller, 'target', 2, 3],
      ['openProject', caller, '/project', actionContext], ['removeProject', caller, '/project', actionContext], ['create', caller, { cwd: '/project', title: 'new', ...config }, actionContext],
      ['configuration', caller, 'target'], ['configure', caller, 'target', config, actionContext],
      ['send', caller, 'target', 'authorized task', actionContext], ['status', caller, 'task'],
      ['wait', caller, 'task', 10000, signal], ['wait', caller, 'task', 120000, signal], ['stop', caller, 'target', actionContext]
    ])
    for (const response of responses) {
      const text = response.content[0].text as string
      expect(text).toContain('Untrusted session data')
      const lines = text.split('\n')
      const fence = lines[1]!.replace(/json$/, '')
      expect(fence).toBe('`'.repeat(8))
      expect(lines.at(-1)).toBe(fence)
      expect(response.structuredContent).toBeUndefined()
    }
    expect(waited.content[0].text).toContain('"timedOut":true')
    expect(task.status).toBe('running')
    caller = 'caller-2'
    ctx.hasUI = false
    await execute('session_send', { sessionId: 'target', text: 'next' }, undefined)
    // The execute helper supplies its default signal, while UI must not leak without hasUI.
    expect(calls.pop()).toEqual(['send', caller, 'target', 'next', { signal, ui: undefined }])
    for (const name of ['session_read', 'session_capabilities', 'session_configure', 'session_send', 'session_stop']) {
      await expect(execute(name, { sessionId: caller, text: 'x' })).rejects.toThrow('caller')
    }
    expect(calls).toEqual([])
    failure = new Error('Busy or permission denied')
    await expect(execute('session_send', { sessionId: 'target', text: 'x' })).rejects.toBe(failure)
    failure = undefined
    calls.length = 0
    cancellable = true
    const controller = new AbortController()
    const pending = execute('session_wait', { taskId: 'task' }, controller.signal)
    const cancelled = new Error('Wait cancelled')
    controller.abort(cancelled)
    await expect(pending).rejects.toBe(cancelled)
    expect(calls.splice(0)).toEqual([['wait', caller, 'task', 10000, controller.signal]])
    expect(task.status).toBe('running')

    const valid: Record<string, unknown> = {
      session_read: { sessionId: 'target', offset: 0, limit: 20 }, session_list: {}, session_open_project: { path: '/p' }, session_remove_project: { path: '/p' },
      session_create: { cwd: '/p', ...config }, session_capabilities: { sessionId: 'target' },
      session_configure: { sessionId: 'target', ...config }, session_send: { sessionId: 'target', text: 'x' },
      session_status: { taskId: 'task' }, session_wait: { taskId: 'task', timeoutMs: 120000 }, session_stop: { sessionId: 'target' }
    }
    for (const name of names) {
      const definition = tool(name)
      const schema = compile(definition.parameters)
      expect(definition.exposure).toBe('deferred')
      expect(definition.namespace.name).toBe('session')
      expect(definition.annotations.readOnlyHint).toBe(!writes.includes(name))
      expect(definition.promptGuidelines).toBeUndefined()
      expect(schema.check(valid[name])).toBe(true)
      expect(schema.check({ ...(valid[name] as object), extra: true })).toBe(false)
      if (writes.includes(name)) {
        expect(definition.prepareArguments(valid[name])).toBe(valid[name])
        expect(() => definition.prepareArguments({ ...(valid[name] as object), extra: true })).toThrow('without coercion')
      }
    }
    for (const invalid of [
      { capabilities: 'tools' }, { capabilities: [{ group: 'tools', id: null, enabled: 'false' }] },
      { capabilities: [{ group: 'bad', id: null, enabled: false }] },
      { capabilities: [{ group: 'tools', enabled: false }] },
      { capabilities: [{ group: 'tools', id: null, enabled: true, extra: 1 }] },
      { model: { provider: 'test' } }, { model: { provider: 'test', id: 'm', secret: 'x' } },
      { model: null }, { thinking: null }, { thinking: 'invalid' }, { title: 123 }
    ]) expect(() => tool('session_create').prepareArguments({ cwd: '/p', ...invalid })).toThrow('without coercion')
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(compile(tool('session_configure').parameters).check({ sessionId: 'target', thinking: level })).toBe(true)
    }
    for (const timeoutMs of [0, -1, 120001, 1.5, '1000']) expect(compile(tool('session_wait').parameters).check({ taskId: 'task', timeoutMs })).toBe(false)
    for (const [name, params] of [['session_remove_project', { path: 1 }], ['session_open_project', { path: 1 }], ['session_send', { sessionId: 'target', text: 1 }], ['session_stop', { sessionId: 1 }], ['session_configure', { sessionId: 'target', capabilities: { group: 'tools', id: null, enabled: false } }]] as const) {
      expect(() => tool(name).prepareArguments(params)).toThrow('without coercion')
    }
    expect(calls).toEqual([])
  } finally {
    keys.forEach((key, i) => { if (previous[i]) registry[key] = previous[i]; else delete registry[key] })
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--session-extension-fixture')) await fixture()
else test('standalone session tools validate strict writes and forward authorized host operations', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--session-extension-fixture'], { timeoutMs: 25000 })
  expect(exitCode, stderr || stdout).toBe(0)
}, 30000)
