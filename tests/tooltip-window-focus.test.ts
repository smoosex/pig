import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import(
    '../src/renderer/src/components/ui/tooltip'
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const tooltip = () => document.querySelector('[role="tooltip"]')

  try {
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          disableHoverableContent: true,
          children: React.createElement(
            Tooltip,
            null,
            React.createElement(TooltipTrigger, { asChild: true }, React.createElement('button', null, 'Trigger')),
            React.createElement(TooltipContent, null, 'Details')
          )
        })
      )
    })
    const trigger = host.querySelector('button')!

    await act(async () => trigger.focus())
    assert.equal(tooltip()?.textContent, 'Details')

    await act(async () => window.dispatchEvent(new Event('blur')))
    assert.equal(tooltip(), null)
    trigger.blur()
    window.dispatchEvent(new Event('focus'))
    await act(async () => trigger.focus())
    assert.equal(tooltip(), null, 'restoring the old active element must not reopen its tooltip')

    await act(async () => trigger.dispatchEvent(new Event('pointermove', { bubbles: true })))
    assert.equal(tooltip()?.textContent, 'Details', 'real pointer intent still opens the tooltip')

    await act(async () => window.dispatchEvent(new Event('blur')))
    assert.equal(tooltip(), null)
    trigger.blur()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    await act(async () => trigger.focus())
    assert.equal(tooltip()?.textContent, 'Details', 'keyboard navigation still opens focused tooltips')
  } finally {
    await act(async () => root.unmount())
    GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--tooltip-window-focus-fixture') {
  await fixture()
} else {
  test('tooltips close on window blur without reopening from restored focus', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--tooltip-window-focus-fixture'], { timeoutMs: 10_000 })
    assert.equal(exitCode, 0, stderr || stdout)
  }, 15_000)
}
