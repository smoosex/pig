import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-mcp-settings-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const settings = await import('../src/main/mcp/settings')
  const { mcpCredentials } = await import('../src/main/mcp/sdk')
  const project = join(root, 'project')
  const other = join(root, 'other')
  try {
    await mkdir(join(project, '.pi'), { recursive: true })
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true })
    const foreign = JSON.stringify({ mcpServers: { forbidden: { command: 'must-not-run' } } })
    await writeFile(join(project, '.pi/mcp.json'), foreign)
    await writeFile(join(process.env.PI_CODING_AGENT_DIR, 'mcp.json'), foreign)
    assert.deepEqual(await settings.configuredServers(), [])
    await mkdir(process.env.PIG_DIR, { recursive: true })
    const imported = JSON.stringify({
      mcpServers: {
        docs: { url: 'https://example.invalid/mcp', enabled: true },
        files: { command: 'must-not-run', args: ['arg'] }
      }
    })
    const preview = await settings.previewMcpImport(imported)
    assert.equal(preview.length, 2)
    assert.ok(preview.every((entry) => !entry.config.enabled && !entry.conflict))
    assert.equal(await stat(join(process.env.PIG_DIR, 'mcp.json')).catch(() => null), null)
    await settings.importMcpServers(imported, [])
    assert.equal((await settings.configuredServers()).length, 2)
    let snapshot = await settings.sessionMcpConfig(project)
    assert.ok(
      snapshot.servers.every(
        (entry) => entry.config.enabled === false && entry.config.exposure === 'deferred'
      )
    )
    if (process.platform !== 'win32')
      assert.equal((await stat(join(process.env.PIG_DIR, 'mcp.json'))).mode & 0o777, 0o600)

    await settings.setMcpEnabled('docs', true)
    const cwds = [project, other, join(root, 'worktree'), join(root, 'chat')]
    for (const cwd of cwds) {
      snapshot = await settings.sessionMcpConfig(cwd)
      assert.equal(snapshot.servers.find((entry) => entry.name === 'docs')?.config.enabled, true)
      assert.equal(snapshot.servers.find((entry) => entry.name === 'files')?.config.enabled, false)
    }
    await settings.setMcpEnabled('docs', false)
    for (const cwd of cwds) {
      snapshot = await settings.sessionMcpConfig(cwd)
      assert.ok(snapshot.servers.every((entry) => entry.config.enabled === false))
    }
    await settings.setMcpEnabled('docs', true)
    await assert.rejects(settings.updateMcpEnabled({ files: true, ghost: true }), /MCP server not found: ghost/)
    await assert.rejects(settings.updateMcpEnabled({ files: true }, () => { throw new Error('stale') }), /stale/)
    assert.deepEqual([(await settings.mcpEnabled()).docs, (await settings.mcpEnabled()).files], [true, false], 'rejected batches write nothing')
    const toggled = await settings.updateMcpEnabled({ docs: false, files: true })
    assert.deepEqual([toggled.docs, toggled.files], [false, true])
    assert.deepEqual(await settings.mcpEnabled(), toggled)
    await settings.updateMcpEnabled({ docs: true, files: false })

    const before = await readFile(join(process.env.PIG_DIR, 'mcp.json'), 'utf8')
    await assert.rejects(settings.importMcpServers(imported, []), /Confirm replacement/)
    assert.equal(await readFile(join(process.env.PIG_DIR, 'mcp.json'), 'utf8'), before)
    await settings.importMcpServers(imported, ['docs', 'files'])
    assert.equal(
      (await settings.configuredServers()).find((entry) => entry.name === 'docs')?.config.enabled,
      true
    )
    await settings.saveMcpServer('foo-bar', { command: 'not-run' }, false)
    // A catalog icon is remembered per server name, outside mcp.json, and dies with the server.
    await settings.saveMcpServer(
      'docs',
      { url: 'https://example.invalid/mcp' },
      true,
      'https://example.invalid/icon.png'
    )
    assert.equal(settings.mcpIcons().docs, 'https://example.invalid/icon.png')
    const stored = JSON.parse(await readFile(join(process.env.PIG_DIR, 'mcp.json'), 'utf8'))
    assert.equal(JSON.stringify(stored).includes('example.invalid/icon.png'), false)
    // An icon only ever belongs to the single entry it was added as.
    await settings.importMcpServers(
      JSON.stringify({ mcpServers: { a: { command: 'not-run' }, b: { command: 'not-run' } } }),
      [],
      undefined,
      'https://example.invalid/icon.png'
    )
    assert.equal(settings.mcpIcons().a, undefined)
    assert.equal(settings.mcpIcons().b, undefined)
    await assert.rejects(
      settings.previewMcpImport('{"mcpServers":{"foo_bar":{"command":"not-run"}}}'),
      /collide/
    )
    await assert.rejects(settings.previewMcpImport('[]'), /JSON object/)
    await assert.rejects(settings.previewMcpImport('{"url":"https://example.invalid"}', ''), /name/)
    // The SDK accepts a stdio config whose command is only a string, so an empty one is rejected here.
    await assert.rejects(
      settings.previewMcpImport('{"mcpServers":{"blank":{"command":"  "}}}'),
      /command must not be empty/
    )
    await settings.saveMcpServer('constructor', { command: 'not-run' }, false)
    assert.equal(
      (await settings.sessionMcpConfig(project)).servers.find(
        (entry) => entry.name === 'constructor'
      )?.config.enabled,
      false
    )
    await settings.saveMcpServer('__proto__', { command: 'not-run' }, false)
    assert.ok((await settings.configuredServers()).some((entry) => entry.name === '__proto__'))
    await settings.setMcpEnabled('__proto__', true)
    assert.equal(
      (await settings.sessionMcpConfig(project)).servers.find((entry) => entry.name === '__proto__')
        ?.config.enabled,
      true
    )

    const credentials = await mcpCredentials()
    const url = 'https://example.invalid/mcp'
    await credentials
      .forServer('docs', url)
      .save({ serverUrl: url, tokens: { access_token: 'private-token', token_type: 'Bearer' } })
    assert.equal(credentials.tokens('docs', url)?.access_token, 'private-token')
    if (process.platform !== 'win32')
      assert.equal((await stat(join(process.env.PIG_DIR, 'mcp-auth.json'))).mode & 0o777, 0o600)
    // Replacing a server keeps its approval only while it still runs the same command or URL.
    const store = await import('../src/main/permissions/store')
    await store.updatePermissionSettings((current) => ({ ...current, mcp: { docs: 'approve', files: 'prompt' } }))
    const docsConfig = (await settings.configuredServers()).find((entry) => entry.name === 'docs')!.config
    await settings.saveMcpServer('docs', { ...docsConfig, timeout: 5 }, true)
    assert.deepEqual(store.readPermissionSettings().mcp, { docs: 'approve', files: 'prompt' })
    await settings.saveMcpServer('files', { command: 'another-command' }, true)
    assert.deepEqual(store.readPermissionSettings().mcp, { docs: 'approve' })
    await settings.removeMcpServer('docs')
    assert.deepEqual(store.readPermissionSettings().mcp, {})
    assert.equal(credentials.tokens('docs', url), undefined)
    assert.equal(settings.mcpIcons().docs, undefined)
    assert.equal(
      (await settings.configuredServers()).some((entry) => entry.name === 'docs'),
      false
    )
    assert.equal(await readFile(join(process.env.PI_CODING_AGENT_DIR, 'mcp.json'), 'utf8'), foreign)
    assert.equal(await readFile(join(project, '.pi/mcp.json'), 'utf8'), foreign)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture()
else
  test('Pig MCP configuration: opt-in import, global enablement, serial writes, credentials and repository isolation', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    assert.equal(code, 0, errors || output)
  })
