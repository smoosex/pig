import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnRequest } from '../src/main/plugins/pig-subagent-host'

test('the jiti-loaded spawn tool reaches the host registered by main', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-subagent-ext-'))
  const previousPig = process.env.PIG_DIR
  const previousPi = process.env.PI_CODING_AGENT_DIR
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  try {
    const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
    const { registerSubagentHost } = await import('../src/main/plugins/pig-subagent-host')
    const path = join(process.cwd(), 'src', 'main', 'plugins', 'pig-subagent', 'index.ts')
    const loader = await createNoExtensionsResourceLoader(root, [path])
    expect(loader.getExtensions().errors).toEqual([])
    const extension = loader.getExtensions().extensions.find((item) => item.path === path)!
    const spawn = extension.tools.get('spawn')!.definition
    expect(spawn.executionMode).toBe('parallel')
    expect(spawn.promptGuidelines?.some((line) => line.includes('Never guess or fabricate'))).toBe(true)

    const requests: SpawnRequest[] = []
    registerSubagentHost({
      spawn: async (request) => {
        requests.push(request)
        return { id: 'abcd1234', text: 'report', isError: false }
      },
      attach: () => {},
      detach: () => {}
    })
    const controller = new AbortController()
    const ctx = {
      cwd: root,
      sessionManager: { getSessionId: () => 'parent', getSessionFile: () => '/sessions/parent.jsonl' },
      model: { provider: 'p', id: 'm' },
      thinkingLevel: 'high'
    }
    const result = await spawn.execute('call-1', { title: 'Map', prompt: 'Do it', background: false }, controller.signal, undefined, ctx as never)
    expect(result).toEqual({ content: [{ type: 'text', text: 'report' }], details: { subagentId: 'abcd1234' }, isError: false })
    expect(requests[0]).toMatchObject({
      parentSessionId: 'parent', parentSessionFile: '/sessions/parent.jsonl', toolCallId: 'call-1', cwd: root, title: 'Map', prompt: 'Do it', background: false,
      parentModel: { provider: 'p', id: 'm' }, parentThinkingLevel: 'high', signal: controller.signal
    })
    await spawn.execute('call-2', { title: 'Bg', prompt: 'Later', background: true }, controller.signal, undefined, ctx as never)
    expect(requests[1].signal).toBeUndefined()
    registerSubagentHost(undefined)
  } finally {
    if (previousPig === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previousPig
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousPi
    await rm(root, { recursive: true, force: true })
  }
})
