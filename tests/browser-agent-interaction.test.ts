/** Run serialized world code in a child DOM; fake CDP proves input ordering without a browser. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import { browserKeyEvent, interactWithPage, pinBrowserScreenshot, type BrowserInteraction } from '../src/main/browser/agent-interaction'
import { snapshotPage } from '../src/main/browser/agent-snapshot'
import { captureHiddenPage } from '../src/main/browser/hidden-screenshot'
import { withBrowserDebugger } from '../src/main/browser/browser-debugger'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  document.body.innerHTML = `<button id="button">Go</button><input id="input" value="old"><input id="password" type="password">
    <textarea id="readonly" readonly></textarea><button id="disabled" disabled>Disabled</button>
    <select id="select"><option value="a">A</option><option value="b">B</option></select>
    <select id="multi" multiple><option value="a">A</option><option value="b">B</option></select><div id="cover"></div><input id="file" type="file">`
  snapshotPage(10_000)
  const refs = (globalThis as unknown as { __pigAgentRefs: Map<string, Element> }).__pigAgentRefs
  const ref = (id: string) => [...refs].find(([, el]) => el.id === id)![0]
  let hit: Element | null = null
  let covered = false
  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    element.style.visibility = 'visible'
    element.scrollIntoView = () => { hit = element }
    element.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, toJSON() {} })
  }
  document.elementFromPoint = () => covered ? document.getElementById('cover') : hit
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let attached = false
  let attaches = 0, detaches = 0, checks = 0, scripts = 0
  let current = true
  let onCommand: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
  const contents = {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async (world: number, source: { code: string }[]) => {
      assert.equal(world, 1207)
      scripts++
      // Match Electron's boundary: uncaught page exceptions lose their original message.
      try { return await new Function(`return ${source[0].code}`)() }
      catch { throw new Error('Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.') }
    },
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; attaches++ },
      detach: () => { attached = false; detaches++ },
      sendCommand: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        return onCommand ? onCommand(method, params) : { data: 'PNG' }
      }
    }
  } as unknown as WebContents
  const check = () => { checks++; if (!current) throw new Error('document changed') }
  const run = (request: BrowserInteraction, signal?: AbortSignal) => interactWithPage(contents, request, signal, check)
  await run({ action: 'click', ref: ref('button') })
  assert.deepEqual(calls.map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.equal(checks > 6, true)
  for (const mouseButton of ['right', 'middle'] as const) {
    const start = calls.length
    await run({ action: 'click', ref: ref('button'), button: mouseButton })
    assert.deepEqual(calls.slice(start).map(call => call.params.button), [undefined, mouseButton, mouseButton])
  }
  const beforeHover = calls.length
  await run({ action: 'hover', ref: ref('button') })
  assert.deepEqual(calls.slice(beforeHover).map(call => call.params.type), ['mouseMoved'])
  const pin = (id: string, validate = false) => new Function(`return (${pinBrowserScreenshot.toString()})(${JSON.stringify(id)}, ${validate})`)()
  pin('shot')
  await run({ action: 'click', x: 10, y: 20, screenshotId: 'shot', button: 'right' })
  assert.deepEqual(calls.at(-2)!.params, { type: 'mousePressed', x: 10, y: 20, button: 'right', clickCount: 1 })
  await assert.rejects(run({ action: 'hover', x: -1, y: 20, screenshotId: 'shot' }), /outside/)
  await assert.rejects(run({ action: 'hover', x: NaN, y: 20, screenshotId: 'shot' }), /outside/)
  await assert.rejects(run({ action: 'hover', x: 10, y: 20, screenshotId: 'old' }), /stale/)
  dispatchEvent(new Event('resize'))
  await assert.rejects(run({ action: 'hover', x: 10, y: 20, screenshotId: 'shot' }), /viewport changed/)
  assert.throws(() => pin('old', true), /stale/)
  pin('scrolled')
  document.dispatchEvent(new Event('scroll', { bubbles: true }))
  assert.throws(() => pin('scrolled', true), /viewport changed/)
  const scrollHost = document.createElement('div')
  document.body.append(scrollHost)
  const scrollRoot = scrollHost.attachShadow({ mode: 'open' })
  const nestedScrollHost = document.createElement('div')
  scrollRoot.append(nestedScrollHost)
  const nestedScrollRoot = nestedScrollHost.attachShadow({ mode: 'open' })
  const scroller = document.createElement('div')
  nestedScrollRoot.append(scroller)
  pin('shadow-scroll')
  scroller.dispatchEvent(new Event('scroll', { bubbles: false, composed: false }))
  assert.throws(() => pin('shadow-scroll', true), /viewport changed/)
  pin('shadow-offset')
  scroller.scrollTop = 40
  await assert.rejects(run({ action: 'click', x: 10, y: 20, screenshotId: 'shadow-offset' }), /viewport changed/)
  scroller.scrollTop = 0
  assert.throws(() => pin('shadow-offset', true), /viewport changed/, 'observed motion stays invalid even if undone')
  // Replacing a pin removes the old root listener rather than invalidating a fresh screenshot.
  pin('discarded')
  nestedScrollRoot.removeChild(scroller)
  pin('fresh')
  scroller.dispatchEvent(new Event('scroll'))
  assert.doesNotThrow(() => pin('fresh', true))
  hit = document.getElementById('file')
  await assert.rejects(run({ action: 'click', x: 10, y: 20, screenshotId: 'fresh' }), /browser_upload/)
  const labelArea = document.createElement('div')
  labelArea.innerHTML = '<label for="file"><span>Upload</span></label><label><input type="file"><span>Nested upload</span></label><label for="input"><span>Normal input</span></label>'
  document.body.append(labelArea)
  const fileLabels = Array.from(labelArea.querySelectorAll('label')).slice(0, 2)
  for (const label of fileLabels) {
    for (const target of [label, label.querySelector('span')!]) {
      hit = target
      const before = calls.length
      await assert.rejects(run({ action: 'click', x: 10, y: 20, screenshotId: 'fresh' }), /browser_upload/)
      refs.set('file-label', target)
      await assert.rejects(run({ action: 'click', ref: 'file-label' }), /browser_upload/)
      assert.equal(calls.length, before, 'labels and nested icons never receive mouse input')
      await run({ action: 'hover', x: 10, y: 20, screenshotId: 'fresh' })
    }
  }
  // A ref to a larger ancestor can still hit a file label at its click point.
  labelArea.style.visibility = 'visible'
  labelArea.scrollIntoView = () => { hit = fileLabels[0]!.querySelector('span')! }
  labelArea.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, toJSON() {} })
  refs.set('label-area', labelArea)
  await assert.rejects(run({ action: 'click', ref: 'label-area' }), /browser_upload/)
  hit = labelArea.querySelector('label[for="input"] span')!
  await run({ action: 'click', x: 10, y: 20, screenshotId: 'fresh' })
  hit = document.createElement('iframe')
  await assert.rejects(run({ action: 'hover', x: 10, y: 20, screenshotId: 'fresh' }), /unsupported frame/)
  await assert.rejects(run({ action: 'hover', ref: ref('button'), x: 10, y: 20, screenshotId: 'fresh' } as unknown as BrowserInteraction), /not both/)
  covered = true
  await assert.rejects(run({ action: 'click', ref: ref('button') }), /covered/)
  covered = false
  await assert.rejects(run({ action: 'click', ref: 'missing' }), /stale/)
  const beforeFile = calls.length
  await assert.rejects(run({ action: 'click', ref: ref('file') }), /use browser_upload/)
  assert.equal(calls.length, beforeFile, 'file inputs never receive a click that would open the native dialog')
  await assert.rejects(run({ action: 'click' } as BrowserInteraction), /Missing or stale screenshot/)
  const button = document.getElementById('button')!
  button.remove()
  await assert.rejects(run({ action: 'click', ref: ref('button') }), /stale/)
  await assert.rejects(run({ action: 'click', ref: ref('disabled') }), /disabled/)
  await assert.rejects(run({ action: 'type', ref: ref('readonly'), text: 'no' }), /editable/)
  await assert.rejects(run({ action: 'type', ref: ref('select'), text: 'no' }), /editable/)
  const payload = '"); globalThis.INJECTED = true; //'
  await run({ action: 'type', ref: ref('input'), text: payload, replace: true })
  const input = document.getElementById('input') as HTMLInputElement
  assert.equal(document.activeElement, input)
  assert.equal(input.selectionStart, 0)
  assert.equal(input.selectionEnd, 3)
  assert.deepEqual(calls.at(-1), { method: 'Input.insertText', params: { text: payload } })
  assert.equal('INJECTED' in globalThis, false)
  await run({ action: 'type', ref: ref('password'), text: 'secret' })
  const select = document.getElementById('select') as HTMLSelectElement
  const events: string[] = []
  select.addEventListener('input', () => events.push('input'))
  select.addEventListener('change', () => events.push('change'))
  await assert.rejects(run({ action: 'select', ref: ref('select'), values: ['missing'] }), /does not exist/)
  assert.equal(select.value, 'a')
  await assert.rejects(run({ action: 'select', ref: ref('select'), values: ['a', 'b'] }), /exactly one/)
  await run({ action: 'select', ref: ref('select'), values: ['b'] })
  assert.equal(select.value, 'b')
  assert.deepEqual(events, ['input', 'change'])
  await run({ action: 'select', ref: ref('multi'), values: ['a', 'b'] })
  assert.deepEqual(Array.from((document.getElementById('multi') as HTMLSelectElement).selectedOptions, option => option.value), ['a', 'b'])
  for (const key of ['Cmd+W', 'Ctrl+Shift+N', 'Ctrl+R', 'Meta+L', 'F99', 'Alt+ArrowLeft']) {
    const before = scripts
    await assert.rejects(run({ action: 'press', key }), /Unsupported|Only/)
    assert.equal(scripts, before)
  }
  await run({ action: 'press', key: 'Ctrl+Shift+Z', ref: ref('input') })
  assert.equal(calls.at(-2)!.params.modifiers, 10)
  assert.equal(calls.at(-1)!.params.type, 'keyUp')
  await run({ action: 'press', key: 'Meta+A', ref: ref('input') })
  if (process.platform === 'darwin') assert.deepEqual(calls.at(-2)!.params.commands, ['selectAll'])
  assert.equal('commands' in calls.at(-1)!.params, false, 'keyup must not execute the editing command again')
  await run({ action: 'press', key: 'Enter' })
  assert.equal(calls.at(-2)!.params.text, '\r')
  let lastScroll = 0
  onCommand = async (_method, params) => {
    if (params.type === 'mouseWheel') {
      for (const delay of [20, 90, 180]) setTimeout(() => {
        input.dispatchEvent(new Event('scroll'))
        lastScroll = performance.now()
      }, delay)
    }
    return {}
  }
  await run({ action: 'scroll', deltaY: 300 })
  assert.equal(calls.at(-1)!.params.type, 'mouseWheel')
  assert.ok(lastScroll > 0 && performance.now() - lastScroll >= 140, 'scroll waits for nested container motion to finish')
  onCommand = undefined
  await assert.rejects(run({ action: 'scroll', deltaY: NaN }), /finite/)

  // Focus can be redirected by page handlers, including inside open shadow roots.
  const shadowHost = document.createElement('div')
  document.body.append(shadowHost)
  const shadow = shadowHost.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<input id="shadowInput"><input id="otherInput"><iframe></iframe>'
  const shadowInput = shadow.querySelector<HTMLInputElement>('#shadowInput')!
  const otherInput = shadow.querySelector<HTMLInputElement>('#otherInput')!
  const frame = shadow.querySelector<HTMLIFrameElement>('iframe')!
  shadowInput.style.visibility = 'visible'
  shadowInput.scrollIntoView = () => { hit = shadowInput }
  shadowInput.getBoundingClientRect = input.getBoundingClientRect
  refs.set('e100', shadowInput)
  await run({ action: 'type', ref: 'e100', text: 'shadow text' })
  for (const action of ['type', 'press'] as const) {
    shadowInput.blur()
    shadowInput.addEventListener('focus', () => queueMicrotask(() => otherInput.focus()), { once: true })
    const before = calls.length
    await assert.rejects(run(action === 'type'
      ? { action, ref: 'e100', text: 'wrong shadow field' }
      : { action, ref: 'e100', key: 'Enter' }), /could not be focused/)
    assert.equal(calls.length, before, 'microtask-redirected shadow focus must not receive native input')
  }
  shadowInput.blur()
  shadowInput.addEventListener('focus', () => otherInput.focus())
  const beforeRedirected = calls.length
  await assert.rejects(run({ action: 'type', ref: 'e100', text: 'wrong field' }), /could not be focused/)
  assert.equal(calls.length, beforeRedirected, 'redirected shadow focus must never receive inserted text')
  await assert.rejects(run({ action: 'press', ref: 'e100', key: 'Enter' }), /could not be focused/)
  frame.focus()
  await assert.rejects(run({ action: 'press', key: 'Enter' }), /Frame input/)
  assert.equal(calls.length, beforeRedirected, 'a focused iframe inside a shadow root must never receive keys')
  input.focus()
  for (const action of ['type', 'press'] as const) {
    input.blur()
    input.addEventListener('focus', () => queueMicrotask(() => document.getElementById('password')!.focus()), { once: true })
    const before = calls.length
    await assert.rejects(run(action === 'type'
      ? { action, ref: ref('input'), text: 'wrong light field' }
      : { action, ref: ref('input'), key: 'Enter' }), /could not be focused/)
    assert.equal(calls.length, before, 'microtask-redirected light DOM focus must not receive native input')
  }

  const interactiveHost = document.createElement('div')
  interactiveHost.setAttribute('role', 'button')
  document.body.append(interactiveHost)
  const buttonShadow = interactiveHost.attachShadow({ mode: 'open' })
  const nestedHost = document.createElement('span')
  buttonShadow.append(nestedHost)
  const nestedShadow = nestedHost.attachShadow({ mode: 'open' })
  nestedShadow.innerHTML = '<span>Click here</span>'
  const inner = nestedShadow.querySelector('span')!
  buttonShadow.elementFromPoint = () => nestedHost
  nestedShadow.elementFromPoint = () => inner
  interactiveHost.style.visibility = 'visible'
  interactiveHost.scrollIntoView = () => { hit = interactiveHost }
  interactiveHost.getBoundingClientRect = input.getBoundingClientRect
  refs.set('e101', interactiveHost)
  assert.equal(interactiveHost.contains(inner), false, 'ordinary contains does not cross shadow boundaries')
  const beforeShadowClick = calls.length
  await run({ action: 'click', ref: 'e101' })
  assert.deepEqual(calls.slice(beforeShadowClick).map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  covered = true
  const beforeCovered = calls.length
  await assert.rejects(run({ action: 'click', ref: 'e101' }), /covered/)
  assert.equal(calls.length, beforeCovered, 'a real obstruction must still block the shadow host click')
  covered = false

  // Navigation after a dispatched press must still release, but never send more normal input.
  onCommand = async (_method, params) => { if (params.type === 'mousePressed') current = false; return {} }
  await assert.rejects(run({ action: 'click', ref: ref('input') }), /document changed/)
  assert.equal(calls.at(-1)!.params.type, 'mouseReleased')
  current = true

  // Abort a running command: reject promptly, release held input, consume a late rejection.
  const controller = new AbortController()
  let rejectPressed!: (error: Error) => void
  let pressed!: () => void
  const started = new Promise<void>(resolve => { pressed = resolve })
  onCommand = async (_method, params) => {
    if (params.type === 'mousePressed') { pressed(); return new Promise((_resolve, reject) => { rejectPressed = reject }) }
    return { data: 'PNG' }
  }
  const beforeCancelled = calls.length
  const pending = run({ action: 'click', ref: ref('input'), button: 'right' }, controller.signal)
  await started
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  rejectPressed(new Error('late command rejection'))
  await captureHiddenPage(contents)
  assert.equal(calls.slice(beforeCancelled).some(call => call.params.type === 'mouseReleased' && call.params.button === 'right'), true)
  assert.equal(attaches, detaches)
  assert.equal(attached, false)
  await GlobalRegistrator.unregister()
}

if (process.argv[2] === '--interaction-fixture') {
  await fixture()
} else {
  test('serialized browser interactions validate refs, edit native fields and use safe CDP input', async () => {
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--interaction-fixture'])
    assert.equal(code, 0, stderr || stdout)
  })

  test('macOS editing shortcuts include Blink commands only on keydown', () => {
    assert.deepEqual(browserKeyEvent('Meta+A', 'darwin').commands, ['selectAll'])
    assert.deepEqual(browserKeyEvent('Cmd+C', 'darwin').commands, ['copy'])
    assert.deepEqual(browserKeyEvent('Meta+X', 'darwin').commands, ['cut'])
    assert.deepEqual(browserKeyEvent('Meta+V', 'darwin').commands, ['paste'])
    assert.deepEqual(browserKeyEvent('Meta+Z', 'darwin').commands, ['undo'])
    assert.deepEqual(browserKeyEvent('Meta+Shift+Z', 'darwin').commands, ['redo'])
    assert.deepEqual(browserKeyEvent('Alt+Backspace', 'darwin').commands, ['deleteWordBackward'])
    assert.equal(browserKeyEvent('Control+A', 'win32').commands, undefined)
    assert.equal(browserKeyEvent('Enter', 'darwin').commands, undefined)
    assert.throws(() => browserKeyEvent('Meta+W', 'darwin'))
  })

  test('cancelled DOM preparation retains debugger ownership until the underlying work settles', async () => {
    let finish!: (point: { x: number; y: number }) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const commands: string[] = []
    let attached = false
    const contents = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: () => { entered(); return new Promise(resolve => { finish = resolve }).then(value => ({ ok: true, value })) },
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true }, detach: () => { attached = false },
        sendCommand: async (method: string) => { commands.push(method); return { data: 'PNG' } }
      }
    } as unknown as WebContents
    const controller = new AbortController()
    const interaction = interactWithPage(contents, { action: 'click', ref: 'e1' }, controller.signal, () => {})
    await started
    controller.abort(new Error('stopped'))
    await assert.rejects(interaction, /stopped/)
    const capture = captureHiddenPage(contents)
    await Promise.resolve()
    assert.deepEqual(commands, [], 'a screenshot cannot start while old page preparation is still running')
    finish({ x: 10, y: 10 })
    assert.equal(await capture, 'PNG')
    assert.deepEqual(commands, ['Page.captureScreenshot'], 'cancelled click never sends input after preparation resolves')
    assert.equal(attached, false)
  })

  test('debugger queue cancels queued work and waits for running work before screenshot ownership', async () => {
    let attached = false
    let finish!: () => void
    let queuedRan = false
    const commands: string[] = []
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true }, detach: () => { attached = false },
        sendCommand: async (method: string) => { commands.push(method); return { data: 'PNG' } }
      }
    } as unknown as WebContents
    const active = new AbortController()
    const first = withBrowserDebugger(contents, () => new Promise<void>(resolve => { finish = resolve }), active.signal)
    const queued = new AbortController()
    const second = withBrowserDebugger(contents, async () => { queuedRan = true }, queued.signal)
    queued.abort(new Error('queued abort'))
    await assert.rejects(second, /queued abort/)
    active.abort(new Error('running abort'))
    await assert.rejects(first, /running abort/)
    const capture = captureHiddenPage(contents)
    assert.deepEqual(commands, [])
    assert.equal(attached, true)
    finish()
    assert.equal(await capture, 'PNG')
    assert.equal(queuedRan, false)
    assert.equal(attached, false)
  })
}
