/** Main-frame input uses snapshot refs in world 1207; no native view/window focus is requested.
 * DOM preparation is serialized without closures. CDP input shares ownership with screenshots. */
import type { WebContents } from 'electron'
import { AGENT_WORLD_ID } from './agent-snapshot'
import { withBrowserDebugger } from './browser-debugger'
import { executeBrowserScript } from './browser-script'

export type BrowserInteraction =
  | { action: 'click'; ref: string }
  | { action: 'type'; ref: string; text: string; replace?: boolean }
  | { action: 'press'; key: string; ref?: string }
  | { action: 'scroll'; ref?: string; deltaX?: number; deltaY: number }
  | { action: 'select'; ref: string; values: string[] }

/** Self-contained: evaluated in the same isolated world as snapshotPage. Never returns field values. */
function prepareInteraction(request: BrowserInteraction, validateFocusOnly = false): { x: number; y: number } {
  const refs = (globalThis as unknown as { __pigAgentRefs?: Map<string, Element> }).__pigAgentRefs
  let element: Element | undefined
  if ('ref' in request && request.ref !== undefined) {
    element = refs?.get(request.ref)
    if (!element || !element.isConnected || element.ownerDocument !== document) throw new Error('Missing or stale browser ref; take a new snapshot')
  }
  const enabled = (el: Element) => {
    if (el.matches(':disabled') || el.closest('[aria-disabled="true"],[inert]')) throw new Error('Browser element is disabled')
  }
  const activeElement = () => {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    return active
  }
  const checkFocus = () => {
    const active = activeElement()
    if (element && active !== element) throw new Error('Browser element could not be focused; inspect a new browser_snapshot before retrying')
    if (active) {
      enabled(active)
      if (['IFRAME', 'FRAME'].includes(active.tagName)) throw new Error('Frame input is not supported; inspect a new browser_snapshot before retrying')
    }
  }
  if (element) enabled(element)
  if (validateFocusOnly) {
    checkFocus()
    return { x: 0, y: 0 }
  }
  if (!element && ['click', 'type', 'select'].includes(request.action)) throw new Error('Browser ref is required')
  if (element) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  let x = innerWidth / 2
  let y = innerHeight / 2
  if (element) {
    const rect = element.getBoundingClientRect()
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
    if (right <= left || bottom <= top || getComputedStyle(element).visibility !== 'visible') throw new Error('Browser element is not visible')
    x = (left + right) / 2
    y = (top + bottom) / 2
    let hit = document.elementFromPoint(x, y)
    // Open shadow roots are outlined by snapshots too; descend without crossing an iframe.
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint(x, y)
      if (!next || next === hit) break
      hit = next
    }
    while (hit && hit !== element) {
      const root = hit.getRootNode()
      hit = hit.assignedSlot ?? hit.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
    }
    if (hit !== element) throw new Error('Browser element is covered by another element')
  }
  if (request.action === 'type') {
    const el = element!
    const textInput = el instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(el.type)
    const textArea = el instanceof HTMLTextAreaElement
    const editable = el instanceof HTMLElement && el.isContentEditable
    if ((!textInput && !textArea && !editable) || ((textInput || textArea) && (el as HTMLInputElement).readOnly)) throw new Error('Browser element is not editable')
    ;(el as HTMLElement).focus({ preventScroll: true })
    checkFocus()
    if (request.replace !== false) {
      if ((textInput && (el as HTMLInputElement).type !== 'email') || textArea) {
        const input = el as HTMLInputElement | HTMLTextAreaElement
        input.setSelectionRange(0, input.value.length)
      } else if (editable) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = window.getSelection()
        if (!selection) throw new Error('Browser text selection is unavailable')
        selection.removeAllRanges()
        selection.addRange(range)
      } else {
        // Email does not expose setSelectionRange; native select handles its full value.
        HTMLInputElement.prototype.select.call(el)
      }
    }
  }
  if (request.action === 'press') {
    if (element) {
      if (!(element instanceof HTMLElement)) throw new Error('Browser element cannot be focused')
      element.focus({ preventScroll: true })
    }
    checkFocus()
  }
  if (request.action === 'select') {
    if (!(element instanceof HTMLSelectElement)) throw new Error('Browser element is not a native select')
    if (!element.multiple && request.values.length !== 1) throw new Error('Single select requires exactly one value')
    const options = Array.from(element.options)
    for (const value of request.values) {
      const matches = options.filter(option => option.value === value)
      if (!matches.length) throw new Error('Select value does not exist')
      if (matches.every(option => option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled))) throw new Error('Select option is disabled')
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected')!.set!
    let selected = false
    for (const option of options) {
      const allowed = !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
      const choose = allowed && request.values.includes(option.value) && (element.multiple || !selected)
      setter.call(option, choose)
      selected ||= choose
    }
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return { x, y }
}

export function browserKeyEvent(value: string, platform: NodeJS.Platform = process.platform): { key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string; commands?: string[] } {
  const parts = value.split('+')
  const name = parts.pop()!
  let modifiers = 0
  for (const part of parts) {
    const bit = ({ ctrl: 2, control: 2, meta: 4, cmd: 4, alt: 1, shift: 8 } as Record<string, number>)[part.toLowerCase()]
    if (!bit || (modifiers & bit)) throw new Error('Unsupported browser key modifier')
    modifiers |= bit
  }
  // Only editing shortcuts may use Control/Meta; Alt is limited to word deletion.
  if ((modifiers & 6) && ((modifiers & 1) || !/^[acvxzy]$/i.test(name))) throw new Error('Only Control/Meta+A/C/V/X/Z/Y editing shortcuts are allowed')
  if ((modifiers & 1) && !['Backspace', 'Delete'].includes(name)) throw new Error('Only Alt+Backspace/Delete editing shortcuts are allowed')
  const special: Record<string, [string, number]> = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    Escape: ['Escape', 27], Space: ['Space', 32], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
    ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35],
    PageUp: ['PageUp', 33], PageDown: ['PageDown', 34]
  }
  let key = name, code: string, vk: number
  if (/^[a-z0-9]$/i.test(name)) {
    key = modifiers & 8 ? name.toUpperCase() : name.toLowerCase()
    code = /[0-9]/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`
    vk = name.toUpperCase().charCodeAt(0)
  } else if (special[name]) {
    ;[code, vk] = special[name]
    if (name === 'Space') key = ' '
  } else throw new Error('Unsupported browser key')
  const text = !(modifiers & 7) ? (key.length === 1 ? key : key === 'Enter' ? '\r' : undefined) : undefined
  let editingCommand: string | undefined
  if (platform === 'darwin') {
    // CDP does not run AppKit's key bindings, so Command editing shortcuts need Blink commands.
    if ((modifiers & 6) === 4) {
      const editing: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', y: 'redo', z: modifiers & 8 ? 'redo' : 'undo' }
      editingCommand = editing[name.toLowerCase()]
    } else if ((modifiers & 7) === 1) {
      editingCommand = name === 'Backspace' ? 'deleteWordBackward' : 'deleteWordForward'
    }
  }
  return { key, code, windowsVirtualKeyCode: vk, modifiers, ...(text === undefined ? {} : { text }), ...(editingCommand ? { commands: [editingCommand] } : {}) }
}

export async function interactWithPage(
  contents: WebContents, request: BrowserInteraction, signal: AbortSignal | undefined, assertCurrent: () => void
): Promise<void> {
  const check = () => { signal?.throwIfAborted(); assertCurrent() }
  const checked = async <T>(start: () => Promise<T>): Promise<T> => {
    check()
    // The outer debugger queue releases the caller on abort, but keeps ownership until this
    // underlying step settles. Otherwise a late focus/select or input could affect the next call.
    const result = await start()
    check()
    return result
  }
  check()
  const key = request.action === 'press' ? browserKeyEvent(request.key) : undefined
  if (request.action === 'scroll' && (!Number.isFinite(request.deltaY) || !Number.isFinite(request.deltaX ?? 0))) throw new Error('Scroll deltas must be finite')
  await checked(() => withBrowserDebugger(contents, async api => {
    const point = await checked(() => executeBrowserScript<{ x: number; y: number }>(contents, AGENT_WORLD_ID,
      `(${prepareInteraction.toString()})(${JSON.stringify(request)})`))
    if (request.action === 'type' || request.action === 'press') {
      // Focus handlers may redirect through microtasks after preparation's synchronous check.
      // Recheck in a separate page task without focusing again before dispatching native input.
      await checked(() => executeBrowserScript(contents, AGENT_WORLD_ID,
        `(${prepareInteraction.toString()})(${JSON.stringify(request)}, true)`))
    }
    const command = (method: string, params: Record<string, unknown>) => checked(() => api.sendCommand(method, params))
    if (request.action === 'click') {
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      check()
      // Release even when cancellation/navigation wins after press. Cleanup must not be gated by
      // assertCurrent: it clears Chromium's held input state, not another document's DOM refs.
      try {
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      } finally {
        await api.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
      }
      check()
    } else if (request.action === 'type') {
      await command('Input.insertText', { text: request.text })
    } else if (request.action === 'press') {
      try { await command('Input.dispatchKeyEvent', { type: 'keyDown', ...key }) }
      finally {
        const { text: _text, commands: _commands, ...release } = key!
        await api.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...release })
      }
      check()
    } else if (request.action === 'scroll') {
      await command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: request.deltaX ?? 0, deltaY: request.deltaY })
    }
  }, signal))
}
