import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const { saveMcpServer, setMcpEnabled, sessionMcpConfig } = await import('../src/main/mcp/settings')
  const { applySessionTools, copySessionCapabilities, defaultToolNames, removeSessionCapabilities, saveSessionCapability, saveSessionCapabilityGroup, readSessionCapabilities, sessionTools } = await import('../src/main/pi/session-capabilities')
  saveSessionCapability('bulk-session', 'skills', '/skill/SKILL.md', true)
  saveSessionCapability('bulk-session', 'tools', 'old-tool', false)
  saveSessionCapabilityGroup('bulk-session', 'tools', ['read', 'write'], true)
  assert.deepEqual(readSessionCapabilities('bulk-session').tools, { read: true, write: true })
  saveSessionCapabilityGroup('bulk-session', 'tools', ['read', 'write'], false)
  assert.deepEqual(readSessionCapabilities('bulk-session').tools, { read: false, write: false })
  saveSessionCapabilityGroup('bulk-session', 'tools', ['read', 'write'], null)
  assert.deepEqual(readSessionCapabilities('bulk-session').tools, {}, 'bulk reset removes overrides, including stale keys')
  assert.deepEqual(readSessionCapabilities('bulk-session').skills, { '/skill/SKILL.md': true }, 'other capability groups are unchanged')
  assert.deepEqual(readSessionCapabilities('fixture-session').tools, {}, 'other sessions are unchanged')
  const sidecar = (id: string) => join(root, 'pig', 'session-capabilities', `${id}.json`)
  saveSessionCapability('fork-source', 'tools', 'bash', false)
  copySessionCapabilities('fork-source', 'fork-target')
  assert.deepEqual(readSessionCapabilities('fork-target').tools, { bash: false }, 'a fork keeps its source overrides')
  copySessionCapabilities('never-configured', 'fork-empty')
  assert.equal(existsSync(sidecar('fork-empty')), false, 'a source without overrides leaves no file')
  await removeSessionCapabilities('fork-target')
  assert.equal(existsSync(sidecar('fork-target')), false)
  const { removeSession, removeProjectSessions } = await import('../src/main/pi/session-removal')
  const { sessionDirForCwd } = await import('../src/main/pi/session-loader')
  const sessionFile = join(root, 'agent', 'sessions', '--fixture--', 'delete-me.jsonl')
  await mkdir(join(sessionFile, '..'), { recursive: true })
  await writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'delete-me', cwd: root }) + '\n')
  saveSessionCapability('delete-me', 'mcp', 'docs', true)
  await removeSession(sessionFile)
  assert.equal(existsSync(sidecar('delete-me')), false, 'deleting a session file removes its overrides')
  assert.ok(existsSync(sidecar('fork-source')), 'other sessions keep theirs')
  const projectDir = sessionDirForCwd(root)
  await mkdir(projectDir, { recursive: true })
  for (const id of ['bulk-one', 'bulk-two']) {
    await writeFile(join(projectDir, `${id}.jsonl`), JSON.stringify({ type: 'session', version: 3, id, cwd: root }) + '\n')
    saveSessionCapability(id, 'skills', '/skill/SKILL.md', false)
  }
  await removeProjectSessions(root)
  for (const id of ['bulk-one', 'bulk-two']) assert.equal(existsSync(sidecar(id)), false, 'bulk deletion removes every sidecar')
  assert.ok(existsSync(sidecar('fork-source')), 'bulk deletion preserves other sessions')
  const { Type } = await import('typebox')
  let registerDeferred!: () => void
  const settingsManager = sessionResourceSettings(root, getAgentDir())
  const pluginFile = join(root, 'fixture-plugin.ts')
  await writeFile(pluginFile, `export default (pi) => pi.registerTool({ name: 'fixture_plugin', label: 'Fixture plugin', description: 'Plugin fixture', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) })`)
  const loader = await createNoExtensionsResourceLoader(root, [pluginFile], {
    settingsManager,
    extensionFactories: [sessionToolFactory(root, 'fixture-session'), (pi) => {
      registerDeferred = () => pi.registerTool({
        name: 'fixture_deferred', label: 'Fixture deferred', description: 'Deferred fixture',
        exposure: 'deferred', parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'called' }], details: {} })
      })
    }]
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
    const defaults = await defaultToolNames(session)
    assert.ok(defaults.includes('read'), 'without a defaultTools setting the SDK list applies')
    assert.equal(session.getActiveToolNames().includes('codemode'), true, 'codemode is active by default like other extension tools')
    assert.equal(sessionTools(session, {}, { defaults }).find((tool) => tool.id === 'codemode')?.defaultEnabled, true)
    const providers = new Map(sessionTools(session, {}, { defaults, plugins: new Map([[pluginFile, 'fixture-plugin']]) }).map((tool) => [tool.id, tool.provider]))
    for (const name of ['read', 'bash', 'codemode', 'tool_search']) assert.deepEqual(providers.get(name), { kind: 'pi' }, name)
    assert.deepEqual(providers.get('fixture_plugin'), { kind: 'plugin', name: 'fixture-plugin' })
    assert.deepEqual(sessionTools(session, {}, { defaults }).find((tool) => tool.id === 'fixture_plugin')?.provider, { kind: 'plugin' }, 'unknown plugin files still count as plugins')
    registerDeferred()
    assert.equal(session.getCallableToolNames().includes('fixture_deferred'), true)
    await applySessionTools(session, { fixture_deferred: false })
    assert.equal(session.getCallableToolNames().includes('fixture_deferred'), false, 'disabled deferred tools cannot be reached through Codemode or discovery')
    const blocked = await session.extensionRunner.createToolContext('blocked', new AbortController().signal).executeTool('fixture_deferred', {})
    assert.equal(blocked.isError, true)
    await applySessionTools(session, {})
    assert.equal(session.getCallableToolNames().includes('fixture_deferred'), true)
    saveSessionCapability('fixture-session', 'tools', 'read', false)
    await applySessionTools(session, readSessionCapabilities('fixture-session').tools)
    assert.equal(session.getCallableToolNames().includes('read'), false)
    assert.equal(session.getActiveToolNames().includes('read'), false)
    assert.equal(sessionTools(session, {}, { defaults }).find((tool) => tool.id === 'read')?.defaultEnabled, true)
    assert.deepEqual(readSessionCapabilities('another-session').tools, {}, 'other sessions inherit defaults')
    await session.reload()
    await applySessionTools(session, readSessionCapabilities('fixture-session').tools, true)
    assert.equal(session.getCallableToolNames().includes('read'), false, 'reload retains the override')
    saveSessionCapability('fixture-session', 'tools', 'read', null)
    await session.reload()
    await applySessionTools(session, readSessionCapabilities('fixture-session').tools, true)
    assert.equal(session.getActiveToolNames().includes('read'), true, 'reset restores the default loadout')
    saveSessionCapability('fixture-session', 'tools', 'codemode', false)
    await session.reload()
    await applySessionTools(session, readSessionCapabilities('fixture-session').tools, true)
    assert.equal(session.getCallableToolNames().includes('codemode'), false, 'a session can disable codemode like any tool')
    saveSessionCapability('fixture-session', 'tools', 'codemode', null)
    await session.reload()
    await applySessionTools(session, readSessionCapabilities('fixture-session').tools, true)
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
    // Without codemode, discovery depends only on deferred capabilities below.
    saveSessionCapability('fixture-session', 'tools', 'codemode', false)
    await session.reload()
    assert.equal(session.getActiveToolNames().includes('codemode'), false)
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
    saveSessionCapability('fixture-session', 'mcp', 'fixture', true)
    assert.equal((await sessionMcpConfig(root)).servers[0].config.enabled, false, 'session override does not change global MCP settings')
    assert.equal((await sessionMcpConfig(root, readSessionCapabilities('fixture-session').mcp)).servers[0].config.enabled, true)
    await session.reload()
    assert.equal(session.getActiveToolNames().includes('tool_search'), true)
    saveSessionCapability('fixture-session', 'mcp', 'fixture', null)
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
    await applySessionTools(session, { tool_search: false }, true)
    assert.equal(session.getActiveToolNames().includes('tool_search'), false)
    await applySessionTools(session, {})
    assert.equal(session.getActiveToolNames().includes('tool_search'), true)
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
  test('real SDK: Codemode as a session tool, direct tools retained, QuickJS execution, hot disable and auxiliary isolation', async () => {
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
