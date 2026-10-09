import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-tool-resources-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const { createAgentSession, ModelRuntime, SessionManager, getAgentDir } = await import(
    '@earendil-works/pi-coding-agent'
  )
  const { createNoExtensionsResourceLoader, sessionResourceSettings } = await import(
    '../src/main/pi/chat-resources'
  )
  const { sessionToolFactory } = await import('../src/main/pi/tool-resources')
  const { setCodemode, saveMcpServer, setMcpEnabled } = await import('../src/main/mcp/settings')
  const settingsManager = sessionResourceSettings(root, getAgentDir())
  const loader = await createNoExtensionsResourceLoader(root, [], {
    settingsManager,
    extensionFactories: [sessionToolFactory(root)]
  })
  assert.deepEqual(loader.getExtensions().errors, [])
  const { session } = await createAgentSession({
    cwd: root,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
  })
  try {
    await session.bindExtensions({
      mode: 'rpc',
      onError: (error) => {
        throw new Error(error.error)
      }
    })
    assert.equal(session.getActiveToolNames().includes('codemode'), false)
    assert.equal(session.extensionRunner.getToolDefinition('codemode'), undefined)
    await setCodemode(true)
    await session.reload()
    assert.equal(session.getActiveToolNames().includes('codemode'), true)
    assert.ok(session.getActiveToolNames().includes('read'), 'on mode retains direct tools')
    const tool = session.extensionRunner.getToolDefinition('codemode')!
    const signal = new AbortController().signal
    const result = await tool.execute(
      'smoke',
      { code: 'return 2 + 2' },
      signal,
      undefined,
      session.extensionRunner.createToolContext('smoke', signal)
    )
    assert.ok(
      result.content.some((item) => item.type === 'text' && item.text.includes('4')),
      JSON.stringify(result)
    )
    await setCodemode(false)
    await session.reload()
    assert.equal(session.getActiveToolNames().includes('codemode'), false)
    assert.equal(session.extensionRunner.getToolDefinition('codemode'), undefined)
    const serverFile = join(root, 'mcp-fixture.cjs')
    await writeFile(
      serverFile,
      `let pending = ''; process.stdin.on('data', chunk => {
      pending += chunk; let index;
      while ((index = pending.indexOf('\\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line); if (message.id === undefined) continue;
        const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : message.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }
          : message.method === 'tools/call' ? { content: [{ type: 'text', text: message.params.arguments.value }] }
          : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      }
    }); process.stdin.on('end', () => process.exit(0));`
    )
    await saveMcpServer('fixture', { command: process.execPath, args: [serverFile] }, false)
    await setMcpEnabled('fixture', true)
    await session.reload()
    assert.equal(session.getActiveToolNames().includes('codemode'), false)
    assert.equal(session.getActiveToolNames().includes('tool_search'), true)
    session.agent.state.messages.push({
      role: 'assistant',
      timestamp: 1,
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture',
      content: [
        { type: 'toolCall', id: 'manual', name: 'tool_search', arguments: { query: 'echo' } }
      ],
      stopReason: 'toolUse',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    })
    const context = session.extensionRunner.createToolContext('manual', signal)
    await session.extensionRunner.emitToolCall({
      type: 'tool_call',
      toolCallId: 'search',
      toolName: 'tool_search',
      input: { query: 'echo' }
    })
    const search = session.extensionRunner.getToolDefinition('tool_search')!
    const discovery = await search.execute('search', { query: 'echo' }, signal, undefined, context)
    assert.ok(
      discovery.content.some((item) => item.type === 'text' && item.text.includes('echo')),
      JSON.stringify(discovery)
    )
    const echo = session.getAllTools().find((entry) => entry.name.includes('echo'))!
    assert.ok(echo, 'tool_search connects deferred MCP and discovers tools')
    assert.ok(
      session.getActiveToolNames().includes(echo.name),
      'discovered MCP is directly callable without Codemode'
    )
    const echoed = await context.executeTool(echo.name, { value: 'independent MCP' })
    assert.equal(echoed.isError, false)
    assert.ok(
      echoed.result.content.some((item) => item.type === 'text' && item.text === 'independent MCP')
    )
    await setMcpEnabled('fixture', false)
    await session.reload()
    assert.equal(
      session.getActiveToolNames().includes('tool_search'),
      false,
      'discovery is deactivated when no deferred capabilities remain'
    )
    assert.equal(session.getCallableToolNames().includes(echo.name), false)
    const auxiliary = await createNoExtensionsResourceLoader(root)
    assert.deepEqual(
      auxiliary.getExtensions().extensions,
      [],
      'internal auxiliary loaders have no tool factories'
    )
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    session.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture()
else
  test('real SDK: Codemode opt-in, direct tools retained, QuickJS execution, hot disable and auxiliary isolation', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, err || out)
    } finally {
      clearTimeout(timer)
    }
  }, 20_000)
