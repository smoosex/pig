import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { Input } = await import('../src/renderer/src/components/ui/input')
  const { Textarea } = await import('../src/renderer/src/components/ui/textarea')
  const { InputGroup, InputGroupInput, InputGroupTextarea } = await import('../src/renderer/src/components/ui/input-group')
  const { Command, CommandInput, CommandList } = await import('../src/renderer/src/components/ui/command')
  const { WorkspaceFilter } = await import('../src/renderer/src/components/panel/WorkspaceFilter')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(h('div', null,
      h(Input, { 'aria-label': 'plain', defaultValue: 'keep this draft' }),
      h(Textarea, { 'aria-label': 'multiline' }),
      h(InputGroup, null, h(InputGroupInput, { 'aria-label': 'grouped' })),
      h(InputGroup, null, h(InputGroupTextarea, { 'aria-label': 'grouped multiline' })),
      h(InputGroup, null, h(InputGroupInput, { 'aria-label': 'disabled grouped', disabled: true })),
      h(Input, { 'aria-label': 'invalid', 'aria-invalid': true }),
      h(Command, null, h(CommandInput, { 'aria-label': 'reference search' }), h(CommandList)),
      h(WorkspaceFilter, { label: 'workspace search', value: '', onChange: () => {} })
    )))
    const input = host.querySelector<HTMLInputElement>('[aria-label="plain"]')!
    const surfaces = [...host.querySelectorAll<HTMLElement>('[data-slot="input-group"], [data-slot="input"], [data-slot="textarea"]')]
    assert.equal(surfaces.length, 8)
    const expected = ['border-glass-border', 'bg-glass-prompt-foreground/6', 'shadow-none', 'outline-none', 'focus-visible:ring-0', 'solid:border-input/30', 'solid:bg-input/30']
    for (const palette of ['pig', 'everforest']) for (const appearance of ['light', 'dark']) for (const material of ['glass', 'solid']) {
      document.documentElement.dataset.palette = palette
      document.documentElement.dataset.surfaceStyle = material
      document.documentElement.classList.toggle('dark', appearance === 'dark')
      input.focus()
      for (const surface of surfaces) {
        for (const token of expected) assert.ok(surface.classList.contains(token), `${surface.dataset.slot}: ${token}`)
        assert.ok(!surface.className.includes('dark:bg-') && !surface.className.includes('disabled:bg-'), 'appearance and disabled states cannot reintroduce different fills')
        assert.ok(!surface.className.includes('border-ring') && !surface.className.includes('ring-focus-ring'), 'normal focus matches the reference without an accent glow')
      }
      assert.equal(document.activeElement, input)
      assert.equal(input.value, 'keep this draft')
    }
    for (const control of host.querySelectorAll<HTMLElement>('[data-slot="input-group-control"]')) {
      assert.ok(control.classList.contains('bg-transparent'))
      assert.ok(control.classList.contains('solid:bg-transparent'), 'only the group paints the control background')
      assert.ok(control.classList.contains('disabled:opacity-100'), 'disabled opacity is applied once by the group')
      assert.ok(!control.classList.contains('bg-glass-prompt-foreground/6'))
    }
    assert.ok(host.querySelector('[aria-label="invalid"]')!.classList.contains('aria-invalid:border-destructive'))
    const workspace = host.querySelector('[aria-label="workspace search"]')!
    assert.ok(workspace.classList.contains('h-6'))
    assert.ok(workspace.parentElement!.classList.contains('rounded-full'), 'existing dimensions and layout stay intact')
  } finally {
    await act(async () => root.unmount())
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--input-surface-fixture')) await fixture()
else {
  test('inputs and search fields share one glass/solid surface without nested or disabled double fills', async () => {
    const result = await runSelf(import.meta.path, ['--input-surface-fixture'])
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
  })
  test('input text and placeholders stay readable on both palettes and materials', async () => {
    const rgb = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
    const mix = (background: number[], foreground: number[], alpha: number) => background.map((channel, index) => channel * (1 - alpha) + foreground[index]! * alpha)
    const luminance = (color: number[]) => color.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
    const readable = (background: number[], foreground: number[]) => {
      const a = luminance(background), b = luminance(foreground)
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5)
    }
    for (const palette of ['pig', 'everforest']) {
      const css = await Bun.file(new URL(`../src/renderer/src/themes/theme-${palette}.css`, import.meta.url)).text()
      for (const block of css.matchAll(/html[^{}]+\{([^{}]+)\}/g)) {
        const colors = new Map([...block[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!]))
        for (const parent of ['background', 'card', 'popover', 'sidebar', 'chat-background']) {
          readable(mix(rgb(colors.get(parent)!), rgb(colors.get('input')!), 0.3), rgb(colors.get('foreground')!))
        }
        const neutral = rgb(colors.get('glass-prompt-foreground')!)
        const glass = mix(rgb(colors.get('glass-prompt-background')!), neutral, 0.06)
        readable(glass, neutral)
        readable(glass, mix(glass, neutral, 0.75))
      }
    }
  })
}
