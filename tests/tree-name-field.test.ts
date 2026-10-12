/**
 * The field a name is typed into.
 *
 * What it settles on is the point: Enter, Escape and a click away all unmount the field, and an unmount
 * blurs a focused field — so the same decision arrives twice, and a field that acted on both would send
 * a rename and then a second, stale one. It reports the name it was given as unchanged rather than
 * asking for a rename to it, because renaming something to the name it already has is not a rename.
 *
 * happy-dom cannot move focus the way a window does, so the blur is delivered by hand: what is being
 * pinned is what the field does with the event, not who sends it.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { TreeNameField } = await import('../src/renderer/src/components/files/TreeNameField')

  const settled: { name: string; unchanged: boolean }[] = []
  let cancelled = 0
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(TreeNameField, {
        initial: 'main.ts',
        depth: 1,
        directory: false,
        path: 'src/main.ts',
        onCommit: (next: string, unchanged: boolean) => settled.push({ name: next, unchanged }),
        onCancel: () => {
          cancelled += 1
        }
      })
    )
  })
  const field = (): HTMLInputElement => {
    const input = container.querySelector('input')
    assert.ok(input, 'the field is on screen')
    return input
  }
  const type = async (value: string) => {
    await act(async () => {
      const input = field()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = async (key: string) => {
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }
  // React delegates `onBlur` from `focusout`, which is the event a real blur actually produces.
  /** A press anywhere, which is what a reader leaving the field does and a menu's hand-back does not. */
  const pointer = async () => {
    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
  }
  /**
   * The app taking the focus for itself, which is what a menu does a moment after it closes: it reaches
   * for the row it was opened from, with the reader having done nothing at all.
   */
  const handBack = async () => {
    await act(async () => {
      const elsewhere = document.createElement('button')
      document.body.append(elsewhere)
      elsewhere.focus()
    })
  }
  const blur = async () => {
    await act(async () => {
      field().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

  try {
    assert.equal(field().value, 'main.ts', 'a rename starts on the name the row has')

    if (name === 'enter') {
      await type('entry.ts')
      await press('Enter')
      assert.deepEqual(settled, [{ name: 'entry.ts', unchanged: false }])
      // The unmount that follows the commit blurs the field; that must not settle anything again.
      await blur().catch(() => {})
      assert.equal(settled.length, 1, 'the blur after Enter settles nothing')
      assert.equal(cancelled, 0)
      return
    }

    if (name === 'escape') {
      await type('entry.ts')
      await press('Escape')
      assert.deepEqual(settled, [], 'Escape commits nothing')
      assert.equal(cancelled, 1)
      await blur().catch(() => {})
      assert.equal(cancelled, 1, 'the blur after Escape abandons nothing a second time')
      return
    }

    if (name === 'unchanged') {
      await press('Enter')
      assert.deepEqual(settled, [{ name: 'main.ts', unchanged: true }], 'the same name is not a rename')
      assert.equal(cancelled, 0)
      return
    }

    if (name === 'empty') {
      await type('   ')
      await press('Enter')
      assert.deepEqual(settled, [], 'an empty name is never sent')
      assert.equal(cancelled, 1, 'the field just goes away')
      return
    }

    if (name === 'blur') {
      // Clicking another row is a commit, not a throwaway: the typing is already there.
      await type('entry.ts')
      await pointer()
      await blur()
      assert.deepEqual(settled, [{ name: 'entry.ts', unchanged: false }])
      assert.equal(cancelled, 0)
      await blur()
      assert.equal(settled.length, 1, 'one click away settles once')
      return
    }

    if (name === 'handback') {
      // A menu gives the focus back to the row it was opened from without the reader reaching for
      // anything. That must not end the field, and it must not take the keyboard out of it either.
      await type('entry.ts')
      await handBack()
      assert.deepEqual(settled, [], 'a hand-back is not a click away')
      assert.equal(cancelled, 0)
      assert.equal(field().value, 'entry.ts', 'the typing is still there')
      assert.equal(document.activeElement, field(), 'and the keyboard is still in the field')
      return
    }

    throw new Error(`unknown case ${name}`)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--tree-name-fixture') {
  await fixture(process.argv[3] ?? 'enter')
} else {
  for (const [name, description] of Object.entries({
    enter: 'Enter commits the typed name once',
    escape: 'Escape abandons without committing',
    unchanged: 'the name it already had is reported as not a rename',
    empty: 'an empty name is never committed',
    blur: 'a click away commits, once',
    handback: 'a menu handing the focus back does not end the field'
  })) {
    test(description, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--tree-name-fixture', name], {
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}
