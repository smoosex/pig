/**
 * Every Pig session replaces the SDK's docs section in place with a note on Pig's own data
 * directory and the files it shares with the pi CLI, followed by the original pi docs.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-docs-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { createSessionRuntime } = await import('../src/main/pi/session-runtime')
    const session = await createSessionRuntime(root, SessionManager.inMemory(root), [])
    await session.bindExtensions({ mode: 'rpc', onError: (error) => { throw new Error(error.error) } })
    const prepare = async () => {
      const run = session as unknown as { _prepareRun(trigger: unknown): Promise<{ role: string; sections?: Record<string, string | null> }[]> }
      const messages = await run._prepareRun({ messageType: 'user', prompt: 'hi', images: [] })
      return messages.find((message) => message.role === 'system')?.sections
    }
    const sections = (await prepare())!
    const docs = sections.docs!
    assert.match(docs, /^<docs>\nYou are running inside Pig/)
    assert.ok(docs.includes(`Pig's data directory for this install is ${join(root, 'pig')}`))
    assert.ok(docs.includes(join(root, 'agent', 'auth.json')), 'shared pi files use the resolved agent directory')
    assert.match(docs, /\n\nPi documentation \(read only when the user asks about pi itself/, 'the original pi docs follow')
    assert.equal(docs.match(/<docs>/g)?.length, 1)
    const order = Object.keys(sections)
    assert.ok(order.indexOf('rules') < order.indexOf('docs') && order.indexOf('docs') < order.indexOf('cwd'), 'docs keeps its position')
    session.agent.state.messages.push({ role: 'system', content: '', sections: sections as Record<string, string>, timestamp: 1 } as never)
    assert.equal(await prepare(), undefined, 'unchanged paths render the same text, so no patch is sent')
    session.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--pig-docs-fixture')) await fixture()
else test('Pig sessions explain Pig data and shared pi files inside the docs section', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--pig-docs-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, err || out)
}, 30_000)
