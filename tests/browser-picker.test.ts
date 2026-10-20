/** Electron mocks and happy-dom globals are isolated from the rest of the suite. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { BrowserElement, BrowserMarker, BrowserPickerOptions } from '../src/shared/browser'

async function fixture(mainFrame: boolean): Promise<void> {
  GlobalRegistrator.register()
  const commands = new Map<string, (...args: unknown[]) => void>()
  const messages: { channel: string; payload: { documentId: string; element?: BrowserElement; comment?: string; id?: string } }[] = []
  let exposures = 0
  mock.module('electron', () => ({
    ipcRenderer: {
      on: (channel: string, listener: (...args: unknown[]) => void) => commands.set(channel, listener),
      removeListener: (channel: string) => commands.delete(channel),
      send: (channel: string, payload: typeof messages[number]['payload']) => messages.push({ channel, payload })
    },
    contextBridge: { exposeInMainWorld: () => { exposures++ } }
  }))
  Object.defineProperty(process, 'isMainFrame', { configurable: true, value: mainFrame })
  const { collectBrowserElement, elementSelector, pickerPosition } = await import('../src/preload/browser-guest')
  assert.equal(exposures, 0)
  assert.equal('api' in window, false)
  if (!mainFrame) {
    assert.equal(commands.size, 0)
    await GlobalRegistrator.unregister()
    return
  }
  const options: BrowserPickerOptions = {
    labels: { comment: '可选评论', add: '添加', cancel: '取消', remove: '删除', update: '更新' },
    theme: { background: 'Canvas', foreground: 'CanvasText', border: 'ButtonBorder', muted: 'GrayText',
      primary: 'Highlight', primaryForeground: 'HighlightText', input: 'Canvas', ring: 'Highlight', shadow: 'CanvasText', destructive: 'crimson' }
  }
  const command = (active: boolean, documentId = 'doc-1', markers: BrowserMarker[] = []): void => {
    commands.get('browser:picker')!({}, { active, documentId, markers, options })
  }
  const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 35)) }
  const click = (element: Element): void => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }))
  }
  const key = (element: Element, value: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, composed: true, cancelable: true, ...init })
    element.dispatchEvent(event)
    return event
  }
  document.body.innerHTML = `<section id="root"><button id="choose">Pick me</button>
    <input type="password" aria-label="password-secret" value="password-secret">
    <input value="input-secret"><textarea>textarea-secret</textarea>
    <div contenteditable="true"><span>editable-secret</span></div>
    <script>script-secret</script><style>style-secret</style></section>`
  const root = document.querySelector('#root')!
  const selected = document.querySelector('button')!
  for (const input of document.querySelectorAll('input, textarea')) {
    Object.defineProperty(input, 'value', { get() { throw new Error('Never read form values') } })
  }
  assert.equal(elementSelector(selected), '#choose')
  const password = collectBrowserElement(document.querySelector('input')!)
  assert.equal(password.name, '')
  assert.equal(password.text, '')
  assert.equal(collectBrowserElement(document.querySelector('textarea')!).text, '')
  assert.equal(collectBrowserElement(document.querySelector('[contenteditable] span')!).text, '')
  assert.equal(collectBrowserElement(root).text, 'Pick me')
  assert.equal(JSON.stringify(collectBrowserElement(root)).includes('secret'), false)
  selected.setAttribute('aria-label', `\u0000${'x'.repeat(1000)}`)
  selected.textContent = 'z'.repeat(2000)
  selected.setAttribute('style', 'color: red; background-image: url(https://secret.invalid); --secret: hidden')
  const snapshot = collectBrowserElement(selected)
  assert.equal(snapshot.name.length, 160)
  assert.equal(snapshot.text.length, 500)
  assert.equal('background-image' in snapshot.styles, false)
  assert.equal('--secret' in snapshot.styles, false)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  const duplicate1 = document.createElement('span')
  const duplicate2 = document.createElement('span')
  duplicate1.id = duplicate2.id = 'duplicate'
  root.append(duplicate1, duplicate2)
  assert.equal(document.querySelector(elementSelector(duplicate2)), duplicate2)
  duplicate2.id = '123:unsafe"id'
  assert.equal(document.querySelector(elementSelector(duplicate2)), duplicate2)
  duplicate2.id = 'a'.repeat(2000)
  assert.ok(elementSelector(duplicate2).length <= 1024)

  let shadow: ShadowRoot | undefined
  const currentShadow = (): ShadowRoot => { assert.ok(shadow); return shadow }
  const query = <T extends Element>(selector: string): T => {
    const element = currentShadow().querySelector<T>(selector)
    assert.ok(element, selector)
    return element
  }
  const attachShadow = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (options): ShadowRoot {
    assert.equal(options.mode, 'closed')
    shadow = attachShadow.call(this, options)
    return shadow
  }
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' })
  command(true)
  assert.equal(shadow, undefined)
  document.dispatchEvent(new Event('DOMContentLoaded'))
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' })
  const overlayHost = currentShadow().host as HTMLElement
  assert.equal(overlayHost.shadowRoot, null)
  assert.equal(overlayHost.style.pointerEvents, 'none')
  assert.equal(currentShadow().querySelector('style'), null, 'picker UI does not depend on unsafe-inline styles')
  assert.equal(currentShadow().adoptedStyleSheets.length, 1)
  assert.equal([...currentShadow().adoptedStyleSheets[0]!.cssRules].some(rule => rule.cssText.includes('backdrop-filter')), false)
  assert.equal(overlayHost.style.getPropertyValue('--pig-primary'), 'Highlight')
  let pageClicks = 0
  let pageDowns = 0
  let pageKeys = 0
  document.body.addEventListener('click', () => pageClicks++)
  document.body.addEventListener('mousedown', () => pageDowns++)
  document.documentElement.addEventListener('click', () => pageClicks++)
  document.documentElement.addEventListener('keydown', () => pageKeys++)
  const box = { x: 12, y: 34, width: 56, height: 78 }
  selected.getBoundingClientRect = () => ({ ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box })
  selected.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  await tick()
  const outline = query<HTMLElement>('.outline')
  assert.equal(outline.style.left, '12px')
  box.y = 90
  window.dispatchEvent(new Event('scroll'))
  await tick()
  assert.equal(outline.style.top, '90px')
  assert.equal(query<HTMLElement>('.selector').textContent, '#choose')
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true })
    selected.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
  }
  click(selected)
  assert.equal(messages.length, 0, 'click only opens the editor')
  assert.equal(pageClicks, 0)
  assert.equal(pageDowns, 0)
  const input = query<HTMLTextAreaElement>('textarea')
  assert.equal(input.maxLength, 4000)
  assert.equal(input.placeholder, options.labels.comment)
  input.value = 'draft survives marker sync'
  command(true)
  assert.equal(query<HTMLTextAreaElement>('textarea'), input)
  assert.equal(input.value, 'draft survives marker sync')
  input.value = ''
  click(query('[data-add]'))
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], { channel: 'browser:element-selected', payload: {
    documentId: 'doc-1', element: collectBrowserElement(selected), comment: ''
  } })
  assert.equal(currentShadow().querySelector('textarea'), null)
  assert.equal(overlayHost.isConnected, true)
  assert.equal(currentShadow().querySelector('.pin'), null, 'no optimistic markers before main sync')

  const first: BrowserMarker = { id: 'one', ordinal: 3, documentId: 'doc-1', selector: '#choose', comment: 'first comment' }
  const second: BrowserMarker = { ...first, id: 'two', ordinal: 4, comment: 'second comment' }
  command(true, 'doc-1', [first])
  await tick()
  assert.equal(query('.pin').textContent, '3')
  click(selected)
  const nextInput = query<HTMLTextAreaElement>('textarea')
  nextInput.value = '第二条'
  nextInput.dispatchEvent(new Event('compositionstart', { bubbles: true, composed: true }))
  key(nextInput, 'Enter')
  nextInput.dispatchEvent(new Event('compositionend', { bubbles: true, composed: true }))
  key(nextInput, 'Enter', { isComposing: true })
  assert.equal(messages.length, 1, 'IME Enter does not submit')
  assert.equal(key(nextInput, 'Enter', { shiftKey: true }).defaultPrevented, false)
  assert.equal(messages.length, 1)
  key(nextInput, 'a')
  assert.equal(pageKeys, 0, 'typing is not intercepted as page interaction')
  key(nextInput, 'Enter')
  assert.equal(messages.length, 2)
  assert.equal(messages[1]!.payload.comment, '第二条')
  assert.equal(pageClicks, 0, 'picker controls never activate webpage handlers')
  command(true, 'doc-1', [first, second, { ...first, id: 'wrong-document', documentId: 'old' }])
  await tick()
  assert.equal(currentShadow().querySelectorAll('.pin').length, 2)
  assert.notEqual(query<HTMLElement>('[data-marker-id="one"]').style.left, query<HTMLElement>('[data-marker-id="two"]').style.left)
  const pin = query<HTMLElement>('[data-marker-id="one"]')
  pin.dispatchEvent(new Event('pointerenter'))
  assert.equal(query('.preview p').textContent, first.comment)
  pin.dispatchEvent(new Event('pointerleave'))
  assert.equal(currentShadow().querySelector('.preview'), null)
  click(pin)
  const edit = query<HTMLTextAreaElement>('.preview textarea')
  assert.equal(edit.value, first.comment, 'clicking a pin opens its comment for editing')
  edit.value = 'edited'
  command(true, 'doc-1', [first, second])
  await tick()
  assert.equal(query<HTMLTextAreaElement>('.preview textarea').value, 'edited', 'marker sync keeps unsaved edits')
  click(query('.preview [data-update]'))
  assert.deepEqual(messages.at(-1), { channel: 'browser:marker-update', payload: { documentId: 'doc-1', id: 'one', comment: 'edited' } })
  assert.equal(currentShadow().querySelector('.preview'), null)
  click(pin)
  click(query('.preview [data-cancel]'))
  assert.equal(currentShadow().querySelector('.preview'), null)
  click(pin)
  click(query('.preview [data-remove]'))
  assert.deepEqual(messages.at(-1), { channel: 'browser:marker-remove', payload: { documentId: 'doc-1', id: 'one' } })
  assert.equal(currentShadow().querySelectorAll('.pin').length, 2, 'main owns deletion')
  command(true, 'doc-1', [second])
  await tick()
  assert.equal(currentShadow().querySelectorAll('.pin').length, 1)
  assert.equal(currentShadow().querySelector('.preview'), null)

  click(selected)
  query<HTMLTextAreaElement>('textarea').value = 'x'.repeat(4001)
  click(query('[data-add]'))
  assert.equal(messages.at(-1)!.payload.comment!.length, 4000)
  click(selected)
  click(query('[data-cancel]'))
  assert.equal(currentShadow().querySelector('textarea'), null)
  const count = messages.length
  click(selected)
  assert.equal(key(query('textarea'), 'Escape').defaultPrevented, true)
  assert.equal(messages.length, count, 'first Escape just closes the editor')
  assert.equal(key(selected, 'Escape').defaultPrevented, true)
  assert.deepEqual(messages.at(-1), { channel: 'browser:picker-cancelled', payload: { documentId: 'doc-1' } })
  await tick()
  assert.equal(currentShadow().querySelectorAll('.pin').length, 1, 'Escape preserves saved pins')
  command(true, 'doc-1', [second])
  click(selected)
  command(false, 'doc-1', [second])
  await tick()
  assert.equal(currentShadow().querySelector('textarea'), null)
  assert.equal(query<HTMLElement>('.outline').style.display, 'none')
  assert.equal(currentShadow().querySelectorAll('.pin').length, 1)
  const beforeStaticPinClick = pageClicks
  click(query('.pin'))
  assert.equal(query<HTMLTextAreaElement>('.preview textarea').value, second.comment)
  assert.equal(pageClicks, beforeStaticPinClick, 'static pins remain interactive without activating the page')
  click(query('.pin'))
  assert.equal(currentShadow().querySelector('.preview'), null)
  const beforePageClick = pageClicks
  click(selected)
  assert.ok(pageClicks > beforePageClick, 'inactive mode allows ordinary page interactions')
  const staticPin = query<HTMLElement>('.pin')
  box.y = 180
  window.dispatchEvent(new Event('scroll'))
  await tick()
  assert.equal(staticPin.style.top, '168px')
  selected.style.display = 'none'
  box.width = 0
  await tick()
  assert.equal(staticPin.style.display, 'none')
  box.width = 56
  selected.style.display = ''
  await tick()
  assert.equal(staticPin.style.display, 'block')
  selected.remove()
  await tick()
  assert.equal(staticPin.style.display, 'none', 'missing elements never use stale coordinates')
  const replacement = selected.cloneNode(true) as HTMLElement
  replacement.getBoundingClientRect = selected.getBoundingClientRect
  root.append(replacement)
  await tick()
  assert.equal(staticPin.style.display, 'none', 'a replacement reusing the selector must not inherit an old marker')
  replacement.remove()
  assert.equal(currentShadow().querySelector('.preview'), null)

  root.append(selected)
  command(false, 'doc-new', [second])
  await tick()
  assert.equal(currentShadow().querySelectorAll('.pin').length, 0, 'new document cannot show old markers even when inactive')
  command(true, 'doc-new')
  click(selected)
  assert.ok(currentShadow().querySelector('textarea'))
  command(true, 'doc-next')
  assert.equal(currentShadow().querySelector('textarea'), null)
  command(true, 'doc-cached')
  const cachedHide = new Event('pagehide')
  Object.defineProperty(cachedHide, 'persisted', { value: true })
  window.dispatchEvent(cachedHide)
  assert.equal(commands.size, 1, 'BFCache keeps its isolated command listener')
  assert.equal(currentShadow().host.isConnected, false)
  command(true, 'doc-restored')
  assert.equal(currentShadow().host.isConnected, true)
  command(true, 'doc-navigation')
  window.dispatchEvent(new Event('pagehide'))
  assert.deepEqual(messages.at(-1), { channel: 'browser:picker-cancelled', payload: { documentId: 'doc-navigation' } })
  assert.equal(commands.size, 0)
  assert.equal(currentShadow().host.isConnected, false)
  assert.equal(exposures, 0)
  assert.equal('api' in window, false)
  assert.deepEqual(pickerPosition({ x: 290, y: 190, height: 10 }, { width: 100, height: 60 }, { x: 0, y: 0, width: 300, height: 200 }), { left: 192, top: 122 })
  assert.deepEqual(pickerPosition({ x: -50, y: -50, height: 10 }, { width: 100, height: 60 }, { x: 10, y: 20, width: 120, height: 100 }), { left: 18, top: 28 })
  await GlobalRegistrator.unregister()
}

if (process.argv[2] === '--browser-picker-fixture') {
  await fixture(process.argv[3] === 'main')
} else {
  for (const mode of ['main', 'subframe']) test(`sandbox browser picker (${mode})`, async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--browser-picker-fixture', mode], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
    }
  })
}
