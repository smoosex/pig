/**
 * The real browser and terminal extensions list themselves in `pig_servers` at run start, like
 * Pi's MCP extension does in `mcp_servers`; switching a server's tools off drops only its line, and
 * the section disappears with the last one so Pi sends a removal patch.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-servers-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  try {
    const { createAgentSession, ModelRuntime, SessionManager, getAgentDir } = await import('@earendil-works/pi-coding-agent')
    const { createNoExtensionsResourceLoader, sessionResourceSettings } = await import('../src/main/pi/chat-resources')
    const { applySessionTools } = await import('../src/main/pi/session-capabilities')
    const plugin = (name: string) => join(process.cwd(), 'src/main/plugins', name, 'index.ts')
    const settingsManager = sessionResourceSettings(root, getAgentDir())
    const loader = await createNoExtensionsResourceLoader(root, [plugin('pig-browser'), plugin('pig-terminal')], { settingsManager })
    assert.deepEqual(loader.getExtensions().errors, [])
    const { session } = await createAgentSession({
      cwd: root, resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
    })
    await session.bindExtensions({ mode: 'rpc', onError: (error) => { throw new Error(error.error) } })
    const internal = session as unknown as {
      _extensionRunner: { emitBeforeAgentStart(trigger: unknown, options: unknown): Promise<{ systemPromptOptions: { sections: Record<string, string> } }> }
      _baseSystemPromptOptions: unknown
    }
    const section = async () => (await internal._extensionRunner.emitBeforeAgentStart(
      { messageType: 'user', prompt: 'hi', images: [] }, internal._baseSystemPromptOptions
    )).systemPromptOptions.sections.pig_servers
    const names = (text: string | undefined) => text?.split('\n').slice(1).map((line) => line.split(' ')[1])

    const both = await section()
    assert.match(both!, /^Pig's built-in tool servers whose tools are not declared to you\. Load their tools with `tool_search`\./)
    assert.deepEqual(names(both), ['browser', 'terminal'])
    assert.match(both!, /- browser \(tool_search\): Pig's built-in browser/)
    assert.equal(await section(), both, 'an unchanged run rebuilds identical text, so Pi sends no patch')

    const off = (prefix: string) => Object.fromEntries(session.getAllTools().filter((tool) => tool.name.startsWith(prefix)).map((tool) => [tool.name, false]))
    await applySessionTools(session, off('browser_'))
    assert.deepEqual(names(await section()), ['terminal'], 'switching the browser off drops only its line')
    await applySessionTools(session, { ...off('browser_'), ...off('terminal_') })
    assert.equal(await section(), undefined, 'with no server left the section is removed')
    await applySessionTools(session, {})
    assert.equal(await section(), both, 'switching back restores the same text')
    session.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--pig-servers-fixture')) await fixture()
else test('built-in browser and terminal list themselves in pig_servers and follow session tool switches', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--pig-servers-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, err || out)
}, 30_000)
