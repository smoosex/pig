import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SystemUIEvent } from '../src/shared/api'

type Scenario = 'base' | 'bounds' | 'expiry' | 'theme'

async function fixture(scenario: Scenario): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  HTMLElement.prototype.scrollIntoView = () => {}
  type ToastOptions = { id: string; duration: number; action?: { onClick: () => void } }
  const shown: Array<{ message: string; options: ToastOptions }> = []
  const dismissed: string[] = []
  const show = (message: string, options: ToastOptions) => { shown.push({ message, options }); return options.id }
  if (scenario !== 'theme') {
    mock.module('sonner', () => ({ Toaster: () => null, toast: Object.assign(show, { error: show, warning: show, dismiss: (id: string) => dismissed.push(id) }) }))
  }
  const originalNow = Date.now
  let now = 1_000
  const timers = new Map<number, { at: number; run: () => void }>()
  if (scenario === 'expiry') {
    Date.now = () => now
    let timerId = 0
    window.setTimeout = ((callback: () => void, delay: number) => {
      const id = ++timerId
      timers.set(id, { at: now + delay, run: () => { timers.delete(id); callback() } })
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof window.clearTimeout
  }
  let listener: ((event: SystemUIEvent) => void) | undefined
  const replies: Array<[string, string | null]> = []
  window.api = {
    onSystemUI: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
    replyReviewUI: async (id: string, value: string | null) => { replies.push([id, value]) }
  } as unknown as typeof window.api
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en', appearance: 'light' })
  const { SystemPluginUI } = await import('../src/renderer/src/components/SystemPluginUI')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = async (session: string) => { await act(async () => root.render(React.createElement(SystemPluginUI, { activeSessionId: session }))) }
  const emit = async (event: SystemUIEvent) => { await act(async () => listener!(event)) }
  try {
    await render('one')
    if (scenario === 'bounds') {
      await act(async () => {
        for (let index = 0; index < 100; index++) listener!({ kind: 'notify', sessionId: 'two', plugin: 'memory', level: 'info', message: `Background ${index}` })
      })
      assert.equal(shown.length, 0)
      await render('two')
      assert.deepEqual(shown.map((item) => item.message), Array.from({ length: 5 }, (_, index) => `Background ${95 + index}`))
      await emit({ kind: 'reset', sessionId: 'two' })
      await render('one')
      shown.length = 0
      await act(async () => {
        for (let index = 0; index < 100; index++) listener!({ kind: 'notify', sessionId: `session-${index}`, plugin: 'memory', level: 'info', message: `Session ${index}` })
      })
      for (let index = 0; index < 100; index++) await render(`session-${index}`)
      assert.deepEqual(shown.map((item) => item.message), Array.from({ length: 20 }, (_, index) => `Session ${80 + index}`))
      return
    }
    if (scenario === 'expiry') {
      const advance = async (time: number) => {
        now = time
        await act(async () => {
          for (const timer of [...timers.values()]) if (timer.at <= now) timer.run()
        })
      }
      await emit({ kind: 'notify', sessionId: 'two', plugin: 'memory', level: 'info', message: 'Still fresh' })
      assert.equal(timers.size, 1)
      assert.equal([...timers.values()][0].at, 9_000)
      await advance(8_500)
      await render('two')
      assert.equal(shown[0].options.duration, 500)
      await advance(9_000)
      assert.ok(dismissed.includes(shown[0].options.id))
      assert.equal(timers.size, 0)
      await render('one')
      await render('two')
      assert.equal(shown.length, 1)
      await emit({ kind: 'notify', sessionId: 'three', plugin: 'memory', level: 'info', message: 'Never activated' })
      await advance(17_000)
      assert.equal(timers.size, 0)
      await render('three')
      assert.equal(shown.length, 1)
      return
    }
    if (scenario === 'theme') {
      const { compile } = await import('tailwindcss')
      const { applyDocumentTheme } = await import('../src/renderer/src/lib/theme')
      const css = await Bun.file(new URL('../src/renderer/src/styles.css', import.meta.url)).text()
      const contract = css.match(/@theme inline \{[\s\S]*?\n\}/)![0]
      const compiler = await compile(`${contract}\n@tailwind utilities;`)
      const styles = document.createElement('style')
      styles.textContent = (await Promise.all(['pig', 'everforest'].map((palette) => Bun.file(new URL(`../src/renderer/src/themes/theme-${palette}.css`, import.meta.url)).text()))).join('\n')
        + compiler.build(['text-muted-foreground!', 'hover:bg-accent!', 'hover:border-border!', 'fixed', 'z-40'])
      document.head.append(styles)
      const message = `Observer failed\n${'detail '.repeat(60)}`
      await emit({ kind: 'notify', sessionId: 'one', plugin: 'memory', level: 'error', message })
      const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) }) }
      await flush()
      const channels = (color: string) => color.startsWith('#')
        ? [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16))
        : color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      const luminance = (color: string) => channels(color).map((value) => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      const contrast = (foreground: string, background: string) => {
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
        return (values[0] + 0.05) / (values[1] + 0.05)
      }
      for (const palette of ['pig', 'everforest'] as const) {
        for (const appearance of ['light', 'dark'] as const) {
          await act(async () => {
            useSettingsStore.setState({ appearance })
            applyDocumentTheme({ appearance, lightTheme: palette, darkTheme: palette })
          })
          assert.equal(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'), appearance)
          const notice = document.querySelector<HTMLElement>('[data-sonner-toast]')!
          const description = notice.querySelector<HTMLElement>('[data-description]')!
          const surface = getComputedStyle(notice)
          const descriptionColor = getComputedStyle(description).color
          assert.deepEqual(channels(descriptionColor), channels(getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground')))
          assert.ok(contrast(descriptionColor, surface.backgroundColor) >= 4.5, `${palette}/${appearance} description contrast`)
          assert.ok(contrast(surface.color, surface.backgroundColor) >= 4.5, `${palette}/${appearance} text contrast`)
          for (const button of notice.querySelectorAll('button')) {
            const control = getComputedStyle(button)
            assert.ok(contrast(control.color, control.backgroundColor) >= 4.5, `${palette}/${appearance} button contrast`)
          }
        }
      }
      const mediaListeners = new Set<(event: MediaQueryListEvent) => void>()
      const media = {
        matches: false,
        addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => mediaListeners.add(callback),
        removeEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => mediaListeners.delete(callback)
      }
      window.matchMedia = () => media as unknown as MediaQueryList
      await act(async () => {
        useSettingsStore.setState({ appearance: 'system' })
        applyDocumentTheme({ appearance: 'system', lightTheme: 'pig', darkTheme: 'pig' })
      })
      assert.equal(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'), 'light')
      await act(async () => {
        media.matches = true
        for (const callback of mediaListeners) callback({ matches: true } as MediaQueryListEvent)
        applyDocumentTheme({ appearance: 'system', lightTheme: 'pig', darkTheme: 'pig' })
      })
      assert.ok(document.documentElement.classList.contains('dark'))
      assert.equal(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'), 'dark')
      await emit({ kind: 'review-state', sessionId: 'one', active: true })
      const indicator = document.querySelector<HTMLElement>('[role="alert"]')!.parentElement!
      assert.equal(getComputedStyle(indicator).position, 'fixed')
      assert.equal(getComputedStyle(indicator).zIndex, '40')
      await act(async () => document.querySelector<HTMLButtonElement>('[data-action]')!.click())
      assert.ok(document.body.textContent?.includes(message))
      await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Continue')!.click())
      await render('two')
      await render('one')
      await flush()
      assert.equal(document.querySelector('[data-sonner-toast]:not([data-removed="true"])'), null)
      return
    }
    await emit({ kind: 'review-prompt', id: 'background', sessionId: 'two', method: 'choose', step: 'branch', options: [{ value: 'main', label: 'main' }] })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await emit({ kind: 'review-prompt', id: 'preset', sessionId: 'one', method: 'choose', step: 'preset', options: [
      { value: 'commit', label: 'A commit', recommended: true },
      { value: 'folder', label: 'Files' }
    ] })
    assert.match(document.body.textContent ?? '', /Recommended/)
    assert.match(document.body.textContent ?? '', /Choose a recent commit/)
    assert.equal(document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value'), 'commit')
    const input = document.querySelector<HTMLInputElement>('[cmdk-input]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'snapshot')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(document.querySelectorAll('[cmdk-item]').length, 1)
    await act(async () => (document.querySelector('[cmdk-item]') as HTMLElement).click())
    assert.deepEqual(replies, [['preset', 'folder']])
    await render('two')
    assert.match(document.body.textContent ?? '', /Select a base branch/)
    await emit({ kind: 'dismiss', id: 'background', sessionId: 'two' })
    await render('one')
    await emit({ kind: 'notify', sessionId: 'two', plugin: 'memory', message: 'Other session', level: 'warning' })
    assert.equal(shown.length, 0)
    const message = `Observer failed\n${'detail '.repeat(60)}`
    await emit({ kind: 'notify', sessionId: 'one', plugin: 'memory', message, level: 'error' })
    assert.equal(shown.length, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => shown[0].options.action!.onClick())
    assert.match(document.body.textContent ?? '', /Notification details/)
    assert.ok(document.body.textContent?.includes(message))
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Continue')!.click())
    await render('two')
    await render('one')
    assert.equal(shown.filter((item) => item.message.startsWith('Observer failed')).length, 1)
    await emit({ kind: 'reset', sessionId: 'one' })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.ok(dismissed.includes(shown[0].options.id))
    await render('two')
    assert.equal(shown.at(-1)?.message, 'Other session')
    await emit({ kind: 'review-prompt', id: 'edit', sessionId: 'two', method: 'edit', step: 'instructions', prefill: 'Focus on concurrency' })
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')?.value, 'Focus on concurrency')
    const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
    await act(async () => cancel.click())
    assert.deepEqual(replies.at(-1), ['edit', null])
  } finally {
    await act(async () => root.unmount())
    Date.now = originalNow
    GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--system-ui-fixture') {
  await fixture(process.argv[3] as Scenario)
} else {
  const cases: Array<[Scenario, string]> = [
    ['base', 'system UI uses searchable review choices and consumes notification details'],
    ['bounds', 'system UI bounds inactive notices per session and across sessions'],
    ['expiry', 'system UI expires inactive notices and never renews them on activation'],
    ['theme', 'real system toasts follow Pig themes with readable child colors and floating review state']
  ]
  for (const [scenario, name] of cases) test(name, async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--system-ui-fixture', scenario], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 15_000)
}
