/** The turn's compact diff meter uses known counts, never a guessed partial total. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.defineProperty(window, 'api', { value: {} })
  const { createElement: h } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { FileChangeCounts } = await import('../src/renderer/src/components/turn/TurnFileChanges')
  const host = document.createElement('div')
  const render = (added: number, removed: number, unknownOperations = 0, indicator = true) => {
    host.innerHTML = renderToStaticMarkup(h(FileChangeCounts, { file: { added, removed, unknownOperations }, indicator }))
    return host.querySelector('[data-change-indicator]')
  }
  try {
    assert.ok(render(16, 11))
    assert.equal(host.textContent, '+16−11')
    assert.equal(host.querySelectorAll('[data-change-indicator] .bg-success').length, 3)
    assert.equal(host.querySelectorAll('[data-change-indicator] .bg-destructive').length, 2)
    assert.equal(host.querySelector('[data-change-indicator]')!.getAttribute('aria-hidden'), 'true')
    render(5, 0)
    assert.equal(host.querySelectorAll('.bg-success').length, 5)
    assert.equal(host.querySelectorAll('.bg-destructive').length, 0)
    render(0, 8)
    assert.equal(host.querySelectorAll('.bg-destructive').length, 5)
    render(1, 1000)
    assert.equal(host.querySelectorAll('.bg-success').length, 1, 'a small nonzero side stays visible')
    assert.equal(host.querySelectorAll('.bg-destructive').length, 4)
    assert.equal(render(0, 0), null)
    assert.equal(host.textContent, '')
    assert.equal(render(16, 11, 1), null)
    assert.equal(host.textContent, '', 'unknown operations do not look like a complete total')
    assert.equal(render(16, 11, 0, false), null)
    assert.equal(host.textContent, '+16−11', 'other compact count consumers keep their existing appearance')
  } finally {
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--turn-counts-fixture')) await fixture()
else test('turn diff counts show five proportional green/red blocks only when complete', async () => {
  const result = await runSelf(import.meta.path, ['--turn-counts-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
