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
  const { effectiveCodemode, effectiveMcpEnabled } = await import('../src/shared/tool-settings')
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
    assert.equal(settings.readToolPreferences().codemode, false)
    await mkdir(process.env.PIG_DIR, { recursive: true })
    const preferencesFile = join(process.env.PIG_DIR, 'tool-settings.json')
    for (const codemode of ['false', null, 0, {}, []]) {
      await writeFile(preferencesFile, JSON.stringify({ codemode }))
      assert.throws(() => settings.readToolPreferences(), { code: 'ERR_PIG_TOOL_CONFIG' })
      await writeFile(
        preferencesFile,
        JSON.stringify({ codemode: true, projects: { [project]: { codemode } } })
      )
      assert.throws(() => settings.readToolPreferences(), { code: 'ERR_PIG_TOOL_CONFIG' })
    }
    await writeFile(
      preferencesFile,
      JSON.stringify({ codemode: true, projects: { [project]: {} } })
    )
    assert.equal(
      effectiveCodemode(settings.readToolPreferences(), project),
      true,
      'only absent project fields inherit'
    )
    await writeFile(preferencesFile, '{}')
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
    let snapshot = await settings.sessionMcpConfig(project, project)
    assert.ok(
      snapshot.servers.every(
        (entry) => entry.config.enabled === false && entry.config.exposure === 'deferred'
      )
    )
    assert.equal(snapshot.codemode, false)
    if (process.platform !== 'win32')
      assert.equal((await stat(join(process.env.PIG_DIR, 'mcp.json'))).mode & 0o777, 0o600)

    await Promise.all([
      settings.setCodemode(true),
      settings.setMcpEnabled('docs', true),
      settings.setProjectToolSettings(project, {
        codemode: false,
        mcp: { docs: false, files: true }
      }),
      settings.setProjectToolSettings(other, { codemode: true })
    ])
    snapshot = await settings.sessionMcpConfig(join(root, 'worktree'), project)
    assert.equal(snapshot.codemode, false)
    assert.equal(snapshot.servers.find((entry) => entry.name === 'docs')?.config.enabled, false)
    assert.equal(snapshot.servers.find((entry) => entry.name === 'files')?.config.enabled, true)
    assert.equal((await settings.sessionMcpConfig(join(root, 'chat'), null)).codemode, true)
    assert.equal(
      (await settings.sessionMcpConfig(join(root, 'chat'), null)).servers.find(
        (entry) => entry.name === 'docs'
      )?.config.enabled,
      true
    )
    await settings.setProjectToolSettings(project, { codemode: null, mcp: { docs: null } })
    const preferences = settings.readToolPreferences()
    assert.equal(effectiveCodemode(preferences, project), true)
    assert.equal(preferences.projects[other].codemode, true)
    assert.equal(Object.hasOwn(preferences.projects[project].mcp, 'docs'), false)

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
    await settings.saveMcpServer('constructor', { command: 'not-run' }, false)
    assert.equal(
      effectiveMcpEnabled(
        { command: 'not-run', enabled: false },
        preferences,
        'constructor',
        project
      ),
      false
    )
    await settings.saveMcpServer('__proto__', { command: 'not-run' }, false)
    assert.ok((await settings.configuredServers()).some((entry) => entry.name === '__proto__'))
    await settings.setProjectToolSettings(project, { mcp: { ['__proto__']: true } })
    assert.equal(
      effectiveMcpEnabled(
        { command: 'not-run', enabled: false },
        settings.readToolPreferences(),
        '__proto__',
        project
      ),
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
    await settings.setProjectToolSettings(project, { mcp: { docs: true } })
    await settings.removeMcpServer('docs')
    assert.equal(credentials.tokens('docs', url), undefined)
    assert.equal(settings.mcpIcons().docs, undefined)
    assert.equal(Object.hasOwn(settings.readToolPreferences().projects[project].mcp, 'docs'), false)
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
  test('Pig MCP configuration: opt-in import, inheritance, serial writes, credentials and repository isolation', async () => {
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
