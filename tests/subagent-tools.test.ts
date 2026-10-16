import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-subagent-tools-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, BrowserWindow: { getAllWindows: () => [] } }))
  const { AgentSession, ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
  mock.module('../src/main/pi/model-settings', () => ({ startModelRuntime: async () => runtime, availableModels: () => [] }))
  const { saveSessionCapability, readSessionCapabilities } = await import('../src/main/pi/session-capabilities')
  const { installPlugin, listPlugins, setPluginScopes } = await import('../src/main/pi/plugins')
  const { createSdkRunner } = await import('../src/main/subagents/sdk-runner')
  const plugin = join(root, 'fixture.ts')
  await writeFile(plugin, `export default (pi) => {
    for (const name of ['fixture_deferred', 'spawn']) pi.registerTool({
      name, label: name, description: name, exposure: name === 'spawn' ? 'direct' : 'deferred',
      parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} })
    })
  }`)
  await installPlugin(plugin)
  await setPluginScopes((await listPlugins()).find((item) => item.source === plugin)!.id, ['project'])
  await setPluginScopes('pi-review', [])
  await setPluginScopes('pi-web-access', [])
  saveSessionCapability('parent', 'tools', 'read', false)
  saveSessionCapability('parent', 'tools', 'codemode', false)
  saveSessionCapability('parent', 'tools', 'fixture_deferred', false)
  saveSessionCapability('parent', 'tools', 'spawn', true)
  const originalPrompt = AgentSession.prototype.prompt
  let calls = 0
  AgentSession.prototype.prompt = async function () {
    calls++
    const disabled = calls === 1
    for (const name of ['read', 'codemode', 'fixture_deferred']) {
      const names = name === 'codemode' ? this.getActiveToolNames() : this.getCallableToolNames()
      assert.equal(names.includes(name), !disabled, name)
    }
    assert.equal(this.getCallableToolNames().includes('spawn'), false, 'spawn is forbidden even if another plugin registers it')
    assert.equal(this.getAllTools().some((tool) => tool.name === 'spawn'), true, 'the fixture exercises forced hiding, not just plugin exclusion')
    // Parent edits after launch do not change the child factory's captured restrictions.
    saveSessionCapability('parent', 'tools', 'read', null)
    const blocked = await this.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'probe', toolName: 'read', input: {} })
    assert.equal(blocked?.block === true, disabled)
    const spawn = await this.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'spawn-probe', toolName: 'spawn', input: {} })
    assert.equal(spawn?.block, true)
  }
  try {
    const runner = createSdkRunner()
    const run = () => runner.start({ id: 'child', parentSessionId: 'parent', cwd: root, prompt: 'test', sessionDir: join(root, 'children') }, () => {})
    const first = await run()
    assert.deepEqual(await first.done, {})
    for (const name of ['codemode', 'fixture_deferred']) saveSessionCapability('parent', 'tools', name, null)
    const second = await run()
    assert.deepEqual(await second.done, {})
    assert.equal(calls, 2)
    assert.equal(readSessionCapabilities('parent').tools.spawn, true, 'child restrictions never overwrite parent preferences')
  } finally {
    AgentSession.prototype.prompt = originalPrompt
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('subagents inherit parent tool restrictions at launch and always block spawn', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally {
    clearTimeout(timer)
  }
}, 20_000)
