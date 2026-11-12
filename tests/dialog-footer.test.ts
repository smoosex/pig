/** Dialog and confirmation actions share the surrounding surface and spacing. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--fixture')) {
  const { createElement: h } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { AlertDialog: Primitive } = await import('radix-ui')
  const { Dialog, DialogFooter } = await import('../src/renderer/src/components/ui/dialog')
  const { AlertDialog, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } = await import('../src/renderer/src/components/ui/alert-dialog')
  const regular = renderToStaticMarkup(h(Dialog, null, h(DialogFooter, { showCloseButton: true })))
  const confirmation = renderToStaticMarkup(h(AlertDialog, { open: true }, h(Primitive.Content, null,
    h(Primitive.Title, null, 'Confirm'), h(Primitive.Description, null, 'Delete this item?'),
    h(AlertDialogFooter, null,
      h(AlertDialogCancel, null, 'Cancel'), h(AlertDialogAction, { variant: 'destructive' }, 'Delete')))))
  const classes = (html: string) => html.match(/data-slot="(?:alert-dialog-footer|dialog-footer)" class="([^"]+)"/)![1].split(/\s+/)
  assert.ok(!classes(confirmation).includes('border-t'))
  assert.ok(!classes(confirmation).includes('pt-4'))
  for (const token of ['shrink-0', 'gap-2', 'sm:justify-end']) assert.ok(classes(confirmation).includes(token))
  for (const token of ['shrink-0', 'gap-2', 'sm:justify-end']) assert.ok(classes(regular).includes(token))
  assert.ok(classes(regular).includes('border-t'))
  assert.ok(classes(regular).includes('pt-4'))
  assert.ok(!classes(regular).some(token => /(?:bg-|-m[bx]-)/.test(token)), 'no separate surface or negative margins')
  assert.match(regular, /data-variant="ghost"/)
  assert.match(confirmation, /data-variant="ghost"/)
  assert.match(confirmation, /data-variant="destructive"/)
  assert.doesNotMatch(regular + confirmation, /data-size="sm"/)
} else test('dialog footers share a flat surface and ghost cancellation without changing destructive actions', async () => {
  const result = await runSelf(import.meta.path, ['--fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
