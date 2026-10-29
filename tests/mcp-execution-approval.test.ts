import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-mcp-execution-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const sdk = await import('@earendil-works/pi-coding-agent')
  const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
  mock.module('../src/main/pi/model-settings', () => ({ startModelRuntime: async () => runtime, availableModels: () => [] }))
  const { saveMcpServer, setMcpEnabled } = await import('../src/main/mcp/settings')
  const { saveSessionPermission } = await import('../src/main/permissions/store')
  const { createSessionRuntime } = await import('../src/main/pi/session-runtime')
  const marker = join(root, 'calls')
  const script = join(root, 'server.cjs')
  await writeFile(script, `const fs = require('node:fs'); let pending = ''; process.stdin.on('data', chunk => {
    pending += chunk; let i;
    while ((i = pending.indexOf('\\n')) >= 0) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1); if (!line.trim()) continue;
      const msg = JSON.parse(line); if (msg.id === undefined) continue;
      const result = msg.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'change', description: 'Change fixture', inputSchema: { type: 'object', properties: {} } }] }
        : msg.method === 'tools/call' ? (fs.appendFileSync(${JSON.stringify(marker)}, 'x'), { content: [{ type: 'text', text: 'called' }] }) : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    }
  }); process.stdin.on('end', () => process.exit(0));`)
  await saveMcpServer('fixture', { command: process.execPath, args: [script], exposure: 'deferred' }, false)
  await setMcpEnabled('fixture', true)
  await saveSessionPermission('parent', 'full-access')
  let enter!: () => void
  let answer!: (value: string) => void
  let choices: string[] = []
  let asked = 0
  let entered = new Promise<void>(resolve => { enter = resolve })
  const approvalUI = { select: async (_title: string, options: string[]) => {
    asked++
    choices = options
    enter()
    return new Promise<string>(resolve => { answer = resolve })
  } }
  const session = await createSessionRuntime(root, sdk.SessionManager.inMemory(root), [], undefined, {
    permissions: { sessionId: 'parent', mode: 'full-access', approvalUI }
  })
  try {
    await session.bindExtensions({ mode: 'print' })
    const signal = new AbortController().signal
    const ctx = session.extensionRunner.createToolContext('discover', signal)
    await session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'search', toolName: 'tool_search', input: { query: 'fixture' } })
    await session.extensionRunner.getToolDefinition('tool_search')!.execute('search', { query: 'fixture' }, signal, undefined, ctx)
    const info = session.getAllTools().find(tool => tool.name === 'mcp__fixture__change')!
    assert.ok(info, 'the real SDK registered the MCP tool')
    const tool = session.extensionRunner.getToolDefinition(info.name)!
    // A parallel batch may preflight in full-access, then execute only after permissions change.
    assert.equal(await session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'batch', toolName: info.name, input: {} }), undefined)
    await saveSessionPermission('parent', 'read-only')
    await assert.rejects(tool.execute('batch', {}, signal, undefined, ctx), /Read-only/)
    assert.equal(existsSync(marker), false)
    assert.equal(asked, 0)

    await saveSessionPermission('parent', 'default')
    const pending = tool.execute('pending', {}, signal, undefined, ctx)
    const outcome = pending.then(() => undefined, error => error)
    await entered
    await saveSessionPermission('parent', 'read-only')
    await saveSessionPermission('parent', 'default')
    assert.match(String(await outcome), /Permission mode changed/)
    answer(choices[1]!)
    await Promise.resolve()
    assert.equal(existsSync(marker), false, 'a late approval cannot dispatch the MCP call')

    entered = new Promise<void>(resolve => { enter = resolve })
    const allowed = tool.execute('allowed', {}, signal, undefined, ctx)
    await entered
    answer(choices[0]!)
    assert.ok((await allowed).content.some(item => item.type === 'text' && item.text === 'called'))
    assert.equal(await readFile(marker, 'utf8'), 'x')
    assert.equal(asked, 2)

    // Nested codemode calls take the same wrapped execution path.
    session.agent.state.messages.push({
      role: 'assistant', timestamp: 1, api: 'openai-completions', provider: 'fixture', model: 'fixture',
      content: [{ type: 'toolCall', id: 'nested', name: 'codemode', arguments: {} }], stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    })
    await saveSessionPermission('parent', 'read-only')
    const nested = await session.extensionRunner.createToolContext('nested', signal).executeTool(info.name, {})
    assert.equal(nested.isError, true)
    assert.equal(await readFile(marker, 'utf8'), 'x')

    // Real Pi parallel batching preflights the first call while a sibling's preflight waits.
    const { Agent } = await import('@earendil-works/pi-agent-core')
    const { Type, createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
    const mcp = session.agent.state.tools.find(item => item.name === info.name)!
    let unblock!: () => void
    let preflightEntered!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    const preflight = new Promise<void>(resolve => { preflightEntered = resolve })
    const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions' as const,
      baseUrl: 'http://unused.invalid', reasoning: false, input: ['text' as const], contextWindow: 10000,
      maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    let requests = 0
    const agent = new Agent({
      initialState: { model, tools: [mcp, { name: 'barrier', label: 'Barrier', description: 'test',
        parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) }] },
      toolExecution: 'parallel',
      streamFn: () => {
        const stream = createAssistantMessageEventStream()
        const first = requests++ === 0
        stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message: {
          role: 'assistant', timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id,
          content: first ? [
            { type: 'toolCall', id: 'batch-mcp', name: info.name, arguments: {} },
            { type: 'toolCall', id: 'batch-barrier', name: 'barrier', arguments: {} }
          ] : [{ type: 'text', text: 'done' }], stopReason: first ? 'toolUse' : 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        } })
        return stream
      }
    })
    agent.beforeToolCall = async ({ toolCall, args }) => {
      if (toolCall.name === 'barrier') { preflightEntered(); await blocked; return undefined }
      return session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: toolCall.id, toolName: toolCall.name, input: args as Record<string, unknown> })
    }
    await saveSessionPermission('parent', 'full-access')
    const run = agent.prompt('test')
    await preflight
    await saveSessionPermission('parent', 'read-only')
    unblock()
    await run
    assert.equal(await readFile(marker, 'utf8'), 'x', 'a previously preflighted MCP call must not reach the server')
    assert.ok(agent.state.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'batch-mcp' && message.isError))
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    session.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('real MCP tool authorizes at execution after preflight and cancels on mode changes', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally { clearTimeout(timeout) }
}, 20_000)
