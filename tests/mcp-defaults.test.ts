/** Default MCPs are seeded as ordinary disabled entries, never started or resurrected after removal. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-mcp-defaults-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('electron', () => ({
    app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle() {} }
  }))
  mock.module('../src/main/pi/session-registry', () => ({ pendingToolSessions: () => [], refreshToolSessions: async () => {} }))
  const { initializeMcpDefaults, configuredServers, sessionMcpConfig, setMcpEnabled, saveMcpServer, removeMcpServer } = await import('../src/main/mcp/settings')
  const path = join(process.env.PIG_DIR, 'mcp.json')
  try {
    await initializeMcpDefaults()
    const initial = (await configuredServers()).find((entry) => entry.name === 'open-computer-use')!
    assert.equal(initial.config.enabled, false)
    assert.ok('command' in initial.config)
    assert.equal(initial.config.command, 'npx')
    assert.deepEqual(initial.config.args, ['-y', 'open-computer-use@1.1.2', 'mcp'])
    const { mcpSettingsState } = await import('../src/main/ipc/mcp')
    const { openComputerUseMcp } = await import('../src/main/mcp/featured')
    assert.equal((await mcpSettingsState()).servers[0].icon, openComputerUseMcp.icon, 'preconfigured servers reuse marketplace icons')
    await saveMcpServer('my-desktop', { ...initial.config, description: 'My desktop tools' }, false)
    const renamed = (await mcpSettingsState()).servers.find((entry) => entry.name === 'my-desktop')!
    assert.equal(renamed.icon, openComputerUseMcp.icon, 'a changed name or description does not hide a matching icon')
    assert.equal(renamed.descriptionKey, undefined, 'custom descriptions remain unchanged')
    await saveMcpServer('my-desktop', initial.config, true, 'https://example.invalid/custom-icon.png')
    assert.equal((await mcpSettingsState()).servers.find((entry) => entry.name === 'my-desktop')!.icon, 'https://example.invalid/custom-icon.png', 'custom icons take priority')
    await removeMcpServer('my-desktop')
    for (const cwd of [join(root, 'project'), join(root, 'chat')]) {
      assert.equal((await sessionMcpConfig(cwd)).servers.find((entry) => entry.name === initial.name)?.config.enabled, false)
    }
    await setMcpEnabled(initial.name, true)
    await initializeMcpDefaults()
    assert.equal((await configuredServers())[0].config.enabled, true, 'startup must preserve a saved enabled choice')
    for (const cwd of [join(root, 'project'), join(root, 'chat')]) {
      assert.equal((await sessionMcpConfig(cwd)).servers.find((entry) => entry.name === initial.name)?.config.enabled, true)
    }
    await saveMcpServer(initial.name, { command: 'custom-ocu', args: ['mcp'] }, true)
    await initializeMcpDefaults()
    const edited = (await configuredServers())[0].config
    assert.ok('command' in edited)
    assert.equal(edited.command, 'custom-ocu', 'ordinary edits survive startup')
    await removeMcpServer(initial.name)
    await initializeMcpDefaults()
    assert.deepEqual(await configuredServers(), [], 'removing a default MCP is durable')

    await mkdir(process.env.PIG_DIR, { recursive: true })
    for (const name of ['open-computer-use', 'open_computer_use']) {
      const config = { command: 'existing-ocu', args: ['mcp'], enabled: true }
      await writeFile(path, JSON.stringify({ mcpServers: { [name]: config } }))
      await initializeMcpDefaults()
      const entries = await configuredServers()
      assert.equal(entries.length, 1, 'do not introduce a colliding MCP namespace')
      assert.equal(entries[0].name, name)
      assert.ok('command' in entries[0].config)
      assert.equal(entries[0].config.command, config.command)
      assert.equal(entries[0].config.enabled, true)
    }
    await writeFile(path, JSON.stringify({ mcpServers: { docs: { command: 'not-run', enabled: true } } }))
    await initializeMcpDefaults()
    assert.equal((await configuredServers()).length, 2, 'existing users also receive the disabled default')
    assert.equal((await configuredServers()).find((entry) => entry.name === 'docs')?.config.enabled, true)

    for (const invalid of ['{broken', '{"mcpServers":[]}', '{"pigDefaults":{"open-computer-use":false}}']) {
      await writeFile(path, invalid)
      await assert.rejects(initializeMcpDefaults())
      assert.equal(await readFile(path, 'utf8'), invalid, 'corrupt settings must not be overwritten')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('Open Computer Use is preconfigured, disabled and shared by project/chat without overwriting user choices', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stderr || stdout)
  } finally { clearTimeout(timeout); child.kill() }
})
