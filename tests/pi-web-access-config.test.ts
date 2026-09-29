import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** The plugin reads Pig's own web-search.json, and tool switches decide what it registers. */
test('Pig config disables tools at registration time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-access-config-'))
  process.env.PIG_DIR = root
  await writeFile(join(root, 'web-search.json'), JSON.stringify({ tools: { webSearch: { enabled: false }, getSearchContent: { enabled: false } } }))
  const plugin = await import('../src/main/plugins/pi-web-access/index.ts')
  const tools: string[] = []
  const api = {
    registerTool: (tool: { name: string }) => { tools.push(tool.name) },
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    exec: async () => ({ code: 0, stdout: '', stderr: '' })
  } as unknown as ExtensionAPI
  plugin.default(api)
  assert.deepEqual(tools.sort(), ['fetch_content', 'source_check'])
})
