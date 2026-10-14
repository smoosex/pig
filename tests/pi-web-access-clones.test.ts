import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * GitHub clones are a module-level cache shared by every extension instance in the process, while
 * each session is its own instance. Ending one tab's session must not delete a clone another tab
 * is still pointing at, and the last live session must still reclaim them.
 *
 * Cloning spawns a real child process, so the fake `git`/`gh` binaries run the real extraction path.
 */

type ToolExecute = (
  callId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown
) => Promise<{ content?: Array<{ type: string; text?: string }> }>

interface FakeSession {
  fetchContent: (params: Record<string, unknown>) => Promise<{ content?: Array<{ type: string; text?: string }> }>
  start: () => Promise<void>
  end: () => Promise<void>
}

function createSession(plugin: { default: (api: ExtensionAPI) => void }, branch: unknown[]): FakeSession {
  const tools = new Map<string, ToolExecute>()
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
  const api = {
    registerTool: (tool: { name: string; execute: ToolExecute }) => { tools.set(tool.name, tool.execute) },
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data }) },
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    getCommands: () => [],
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined
  }
  plugin.default(api as unknown as ExtensionAPI)
  const ctx = {
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    scopedModels: [],
    sessionManager: { getBranch: () => branch, getSessionId: () => 'session' }
  }
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx)
  }
  const fetchContent = tools.get('fetch_content')
  assert.ok(fetchContent, 'fetch_content was not registered')
  return {
    fetchContent: (params) => fetchContent('fetch-call', params, undefined, undefined, ctx),
    start: () => emit('session_start'),
    end: () => emit('session_shutdown')
  }
}

async function writeFakeBinary(binDir: string, name: string, source: string): Promise<void> {
  const path = join(binDir, name)
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`)
  await chmod(path, 0o755)
}

test('ending one tab keeps a clone another tab still points at', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-access-clones-'))
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  // `gh` is absent so the plain `git clone` path runs; the fake writes a file where a repo would be.
  await writeFakeBinary(binDir, 'gh', 'process.exit(1);')
  await writeFakeBinary(binDir, 'git', `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const destination = process.argv.at(-1);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "README.md"), "fixture");
  `)

  const previousPath = process.env.PATH
  const previousPigDir = process.env.PIG_DIR
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ''}`
  process.env.PIG_DIR = root
  await writeFile(join(root, 'web-search.json'), JSON.stringify({
    githubClone: { clonePath: join(root, 'repos') },
    // A fake-IP TUN proxy resolves github.com into 198.18/15 on this machine; the clone still runs
    // the real path, so declare the range the same way a user behind such a proxy would.
    ssrf: { allowRanges: ['198.18.0.0/15'] }
  }))

  try {
    const plugin = await import('../src/main/plugins/pi-web-access/index.ts')
    const tabA = createSession(plugin, [])
    const tabB = createSession(plugin, [])
    await tabA.start()
    await tabB.start()

    const fetched = await tabA.fetchContent({ url: 'https://github.com/owner/repo', forceClone: true })
    const text = fetched.content?.[0]?.text ?? ''
    const clonePath = text.match(/Repository cloned to: (.+)/)?.[1]?.trim() ?? null
    assert.ok(clonePath, `fetch_content returned no clone path: ${text.slice(0, 300)}`)
    assert.ok(existsSync(clonePath), 'the clone exists after fetching')

    // Tab B is mid-turn when tab A closes: A's clones are still reachable from B's stored result.
    await tabA.end()
    assert.ok(existsSync(clonePath), 'closing another tab must not delete a clone a live session points at')

    // The last live session ending reclaims it.
    await tabB.end()
    assert.equal(existsSync(clonePath), false, 'the last live session ending reclaims the clone')
  } finally {
    process.env.PATH = previousPath
    if (previousPigDir === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previousPigDir
    await rm(root, { recursive: true, force: true })
  }
})
