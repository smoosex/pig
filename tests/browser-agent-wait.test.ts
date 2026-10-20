/** Wait predicates run serialized in the isolated main-frame world, with no page-provided code. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'https://example.test' })
  const { pageElementMatches } = await import('../src/main/browser/agent-wait')
  const run = (options: Parameters<typeof pageElementMatches>[0]) => new Function(`return (${pageElementMatches.toString()})(${JSON.stringify(options)})`)() as boolean
  document.body.innerHTML = '<div id="ready">Ready</div><div hidden><button id="hidden">Hidden</button></div>'
  const element = document.getElementById('ready')!
  const refs = new Map([['e1', element]])
  Object.assign(globalThis, { __pigAgentRefs: refs })
  assert.equal(run({ selector: '#ready' }), true)
  assert.equal(run({ selector: '#missing' }), false)
  assert.equal(run({ selector: '#missing', state: 'hidden' }), true)
  assert.equal(run({ selector: '#missing', state: 'detached' }), true)
  assert.equal(run({ selector: '#hidden', state: 'visible' }), false)
  assert.equal(run({ selector: '#hidden', state: 'attached' }), true)
  assert.equal(run({ ref: 'e1', state: 'visible' }), true)
  element.remove()
  assert.equal(run({ ref: 'e1', state: 'detached' }), true)
  document.body.innerHTML = '<div id="ready">Replacement</div>'
  assert.equal(run({ ref: 'e1', state: 'visible' }), false, 'a detached ref does not bind to a replacement element')
  assert.equal(run({ selector: '#ready', state: 'visible' }), true)
  assert.throws(() => run({ ref: 'e2' }), /Unknown browser ref/)
  assert.throws(() => run({ selector: '[' }), 'invalid CSS selectors reject rather than timing out silently')
  await GlobalRegistrator.unregister()
}

if (process.argv.includes('--wait-fixture')) await fixture()
else test('serialized browser waits match visibility, attachment, missing selectors and stale refs', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--wait-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, stderr || stdout)
})
