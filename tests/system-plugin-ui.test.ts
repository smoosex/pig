import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SystemUIEvent } from '../src/shared/api'

type Scenario = 'base' | 'bounds' | 'expiry' | 'theme' | 'returning' | 'returning-race'

async function fixture(scenario: Scenario): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  HTMLElement.prototype.scrollIntoView = () => {}
  type ToastOptions = { id: string; duration: number; description?: string; action?: { onClick: () => void } }
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
  const submittedPrompts: Array<[string, string]> = []
  window.api = {
    onSystemUI: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
    replyReviewUI: async (id: string, value: string | null) => { replies.push([id, value]) },
    listSubagents: async () => [],
    onSubagentsChanged: () => () => {},
    prompt: async (sessionId: string, text: string) => { submittedPrompts.push([sessionId, text]) }
  } as unknown as typeof window.api
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en', appearance: 'light' })
  const { SystemPluginUI } = await import('../src/renderer/src/components/SystemPluginUI')
  const { ReviewStatus } = await import('../src/renderer/src/components/composer/ReviewStatus')
  const { useSystemUIStore } = await import('../src/renderer/src/stores/system-ui')
  const Composer = scenario === 'returning-race' ? (await import('../src/renderer/src/components/Composer')).Composer : null
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  if (Composer) {
    const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
    const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
    useSessionsStore.setState({
      runtime: { one: emptyRuntime(), two: emptyRuntime() },
      refreshCwd: async () => {}, loadControls: async () => {}, hydrateTurns: async () => true
    })
    Object.assign(window.api, {
      getCommands: async () => [], onPluginsChanged: () => () => {},
      isMemoryPluginEnabled: async () => false,
      prepareSession: async (sessionId: string) => ({ sessionId, cwd: '/project', created: false })
    })
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = async (session: string) => {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(SystemPluginUI, { activeSessionId: session }),
      Composer ? React.createElement(TooltipProvider, null,
        React.createElement<NonNullable<Parameters<typeof Composer>[0]>>(Composer, { explicitSessionId: session }))
        : React.createElement('div', { className: '@container/composer-column' }, React.createElement(ReviewStatus, { key: session, sessionId: session }))
    )))
  }
  const emit = async (event: SystemUIEvent) => { await act(async () => listener!(event)) }
  try {
    await render('one')
    if (scenario === 'returning-race') {
      let finishOriginal!: () => void
      let rejectDuplicate!: (error: Error) => void
      const original = new Promise<void>((resolve) => { finishOriginal = resolve })
      const duplicate = new Promise<void>((_resolve, reject) => { rejectDuplicate = reject })
      window.api.prompt = async (sessionId, text) => {
        submittedPrompts.push([sessionId, text])
        return submittedPrompts.length === 1 ? original : duplicate
      }
      const editor = () => document.querySelector<HTMLElement>('.ProseMirror')!
      const returnButton = () => document.querySelector<HTMLButtonElement>('[data-review-status] button')!
      const sendButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Send"], button[aria-label="Queue"]')!
      const paste = (text: string) => {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text/plain', text)
        editor().dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
      }
      await emit({ kind: 'review-state', sessionId: 'one', active: true })
      await act(async () => { paste('/end-review') })
      await act(async () => { sendButton().click() })
      assert.deepEqual(submittedPrompts, [['one', '/end-review']])
      assert.equal(returnButton().disabled, false, 'the host event has not reached the button yet')
      await act(async () => { paste('Keep this draft') })
      await act(async () => { returnButton().click() })
      assert.deepEqual(submittedPrompts, [['one', '/end-review'], ['one', '/end-review']])
      assert.equal(returnButton().disabled, true)
      assert.equal(document.querySelector('[data-review-status]')?.getAttribute('data-review-glow'), 'false', 'the glow stops immediately when return is requested')
      await emit({ kind: 'review-returning', sessionId: 'one', returning: true })
      assert.equal(editor().getAttribute('contenteditable'), 'false')
      assert.equal(sendButton().disabled, true)
      const rejection = Object.assign(new Error('Duplicate return request'), { code: 'ERR_REVIEW_RETURNING' })
      await act(async () => { rejectDuplicate(rejection) })
      assert.equal(shown.length, 1, 'the rejected duplicate is reported at the UI boundary')
      assert.equal(shown[0].options.description, rejection.message)
      assert.equal(useSystemUIStore.getState().returningReviewSessions.one, true, 'a duplicate rejection cannot release the original return lock')
      assert.equal(returnButton().disabled, true)
      assert.equal(editor().getAttribute('contenteditable'), 'false')
      assert.equal(sendButton().disabled, true)
      await render('two')
      assert.equal(editor().getAttribute('contenteditable'), 'true', 'the return does not lock another session')
      await render('one')
      assert.equal(editor().getAttribute('contenteditable'), 'false')
      assert.equal(sendButton().disabled, true)
      await emit({ kind: 'review-returning', sessionId: 'one', returning: false })
      await act(async () => { finishOriginal() })
      assert.equal(editor().getAttribute('contenteditable'), 'true')
      assert.equal(editor().textContent, 'Keep this draft')
      assert.equal(sendButton().disabled, false)
      assert.equal(returnButton().disabled, false)
      return
    }
    if (scenario === 'returning') {
      await emit({ kind: 'review-state', sessionId: 'one', active: true })
      assert.equal(document.querySelector('[data-review-status]')?.getAttribute('data-review-glow'), 'true')
      await emit({ kind: 'review-returning', sessionId: 'one', returning: true })
      assert.equal(document.querySelector('[data-review-status]')?.getAttribute('data-review-glow'), 'false', 'the review glow stops while returning')
      await emit({ kind: 'review-returning', sessionId: 'one', returning: false })
      assert.equal(document.querySelector('[data-review-status]')?.getAttribute('data-review-glow'), 'true', 'an unfinished review resumes its glow')
      await emit({ kind: 'review-returning', sessionId: 'one', returning: true })
      assert.equal(useSystemUIStore.getState().returningReviewSessions.one, true)
      assert.equal(document.querySelector<HTMLButtonElement>('[data-review-status] button')?.disabled, true)
      assert.match(document.querySelector('[data-review-status]')?.textContent ?? '', /Returning/)
      await render('two')
      assert.equal(useSystemUIStore.getState().returningReviewSessions.two, undefined)
      assert.equal(document.querySelector('[data-review-status]'), null)
      await render('one')
      assert.equal(document.querySelector<HTMLButtonElement>('[data-review-status] button')?.disabled, true)
      await emit({ kind: 'review-state', sessionId: 'one', active: false })
      assert.equal(useSystemUIStore.getState().returningReviewSessions.one, true, 'return stays locked after leaving review mode')
      await emit({ kind: 'review-returning', sessionId: 'one', returning: false })
      assert.equal(useSystemUIStore.getState().returningReviewSessions.one, undefined)
      assert.equal(document.querySelector('[data-review-status]'), null)
      await emit({ kind: 'review-returning', sessionId: 'one', returning: true })
      await emit({ kind: 'reset', sessionId: 'one' })
      assert.equal(useSystemUIStore.getState().returningReviewSessions.one, undefined)
      return
    }
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
        + compiler.build([
          'text-muted-foreground!', 'hover:bg-accent!', 'hover:border-border!', 'fixed', 'z-40',
          'text-glass-prompt-foreground!', 'opacity-70', 'bg-[image:var(--glass-popover-sheen)]!',
          'shadow-glass-popover!', 'bg-[image:var(--glass-button-sheen)]!', 'shadow-glass-button!', 'bg-glass-popover-background!'
        ])
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
      const contrast = (foreground: string, background: string, opacity = 1) => {
        const base = channels(background)
        const blended = `rgb(${channels(foreground).map((value, index) => value * opacity + base[index] * (1 - opacity)).join(',')})`
        const values = [luminance(blended), luminance(background)].sort((a, b) => b - a)
        return (values[0] + 0.05) / (values[1] + 0.05)
      }
      for (const surfaceStyle of ['solid', 'glass'] as const) for (const palette of ['pig', 'everforest'] as const) {
        for (const appearance of ['light', 'dark'] as const) {
          await act(async () => {
            useSettingsStore.setState({ appearance, surfaceStyle })
            applyDocumentTheme({ appearance, lightTheme: palette, darkTheme: palette, surfaceStyle })
          })
          assert.equal(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'), appearance)
          const notice = document.querySelector<HTMLElement>('[data-sonner-toast]')!
          const description = notice.querySelector<HTMLElement>('[data-description]')!
          const surface = getComputedStyle(notice)
          const descriptionColor = getComputedStyle(description).color
          const theme = getComputedStyle(document.documentElement)
          assert.deepEqual(channels(descriptionColor), channels(theme.getPropertyValue(surfaceStyle === 'glass' ? '--glass-prompt-foreground' : '--muted-foreground')))
          assert.ok(contrast(descriptionColor, surface.backgroundColor, Number(getComputedStyle(description).opacity) || 1) >= 4.5, `${surfaceStyle}/${palette}/${appearance} description contrast`)
          assert.ok(contrast(surface.color, surface.backgroundColor) >= 4.5, `${palette}/${appearance} text contrast`)
          for (const button of notice.querySelectorAll('button')) {
            const control = getComputedStyle(button)
            assert.ok(contrast(control.color, control.backgroundColor) >= 4.5, `${surfaceStyle}/${palette}/${appearance} button contrast`)
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
        applyDocumentTheme({ appearance: 'system', lightTheme: 'pig', darkTheme: 'pig', surfaceStyle: 'glass' })
      })
      assert.equal(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'), 'light')
      await act(async () => {
        media.matches = true
        for (const callback of mediaListeners) callback({ matches: true } as MediaQueryListEvent)
        applyDocumentTheme({ appearance: 'system', lightTheme: 'pig', darkTheme: 'pig', surfaceStyle: 'glass' })
      })
      assert.ok(document.documentElement.classList.contains('dark'))
      assert.equal(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'), 'dark')
      await emit({ kind: 'review-state', sessionId: 'one', active: true })
      const reviewStatus = document.querySelector<HTMLElement>('[data-review-status]')!
      assert.match(reviewStatus.textContent ?? '', /Review active/)
      await act(async () => reviewStatus.querySelector('button')!.click())
      assert.deepEqual(submittedPrompts, [['one', '/end-review']])
      await act(async () => document.querySelector<HTMLButtonElement>('[data-action]')!.click())
      assert.ok(document.body.textContent?.includes(message))
      await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Continue')!.click())
      await render('two')
      assert.equal(document.querySelector('[data-review-status]'), null)
      await render('one')
      assert.ok(document.querySelector('[data-review-status]'))
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
    ['returning', 'review return state follows its session and resets only when the return finishes'],
    ['returning-race', 'a rejected duplicate return cannot unlock the composer while the original return is active'],
    ['bounds', 'system UI bounds inactive notices per session and across sessions'],
    ['expiry', 'system UI expires inactive notices and never renews them on activation'],
    ['theme', 'real system toasts follow Pig themes and review state stays with its session']
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
