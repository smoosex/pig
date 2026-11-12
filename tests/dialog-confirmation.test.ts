/** Confirmations focus the dialog, not an action; ordinary forms keep autofocus. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--fixture')) {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } = await import('../src/renderer/src/components/ui/dialog')
  const { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } = await import('../src/renderer/src/components/ui/alert-dialog')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  try {
    for (const alert of [false, true]) {
      await act(async () => root.render(alert
        ? h(AlertDialog, { key: 'alert' },
          h(AlertDialogTrigger, null, 'Open'),
          h(AlertDialogContent, null,
            h(AlertDialogTitle, null, 'Delete item'),
            h(AlertDialogDescription, null, 'This cannot be undone.'),
            h(AlertDialogFooter, null,
              h(AlertDialogCancel, null, 'Cancel'), h(AlertDialogAction, null, 'Delete'))))
        : h(Dialog, { key: 'confirm' },
          h(DialogTrigger, null, 'Open'),
          h(DialogContent, { confirmation: true, showCloseButton: false },
            h(DialogHeader, null,
              h(DialogTitle, null, 'Delete item'), h(DialogDescription, null, 'This cannot be undone.')),
            h(DialogFooter, null,
              h(DialogClose, null, 'Cancel'), h('button', null, 'Delete'))))))
      const trigger = host.querySelector('button')!
      trigger.focus()
      await act(async () => trigger.click())
      await flush()
      const content = document.querySelector<HTMLElement>(alert ? '[role="alertdialog"]' : '[role="dialog"]')!
      assert.equal(document.activeElement, content, 'no action is selected on open')
      const footer = content.querySelector<HTMLElement>(alert ? '[data-slot="alert-dialog-footer"]' : '[data-slot="dialog-footer"]')!
      assert.ok(!footer.classList.contains('border-t'))
      assert.ok(!footer.classList.contains('pt-4'))
      const cancel = footer.querySelector('button')!
      cancel.focus()
      assert.equal(document.activeElement, cancel, 'actions remain keyboard focusable')
      await act(async () => cancel.click())
      await flush()
      assert.equal(document.activeElement, trigger, 'closing restores focus to the trigger')
      await act(async () => root.render(null))
      await flush()
    }
    await act(async () => root.render(h(Dialog, { open: true },
      h(DialogContent, null,
        h(DialogTitle, null, 'Edit item'), h(DialogDescription, null, 'Enter a value.'),
        h('input', { 'aria-label': 'Value' }), h(DialogFooter, null, h('button', null, 'Save'))))))
    await flush()
    assert.equal(document.activeElement, document.querySelector('input'), 'ordinary forms retain input autofocus')
    const title = document.querySelector('[data-slot="dialog-title"]')!
    for (const token of ['flex', 'min-h-7', 'items-center']) assert.ok(title.classList.contains(token))
    assert.ok(!title.classList.contains('h-7'), 'multiline titles can grow beyond the close-button height')
    const close = document.querySelector('[data-slot="dialog-close"]')!
    assert.equal(close.getAttribute('data-size'), 'icon-sm')
    assert.ok(close.classList.contains('top-4'), 'title and close button share the dialog top inset')
    assert.ok(document.querySelector('[data-slot="dialog-footer"]')!.classList.contains('border-t'))
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await GlobalRegistrator.unregister()
  }
} else test('confirmations open without focusing an action or drawing a footer separator', async () => {
  const result = await runSelf(import.meta.path, ['--fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
