/** Isolated guest picker and DevTools resize edge; DOM references stay in the guest. */
import { ipcRenderer } from 'electron'
import {
  BROWSER_PICKER_CHANNEL, BROWSER_SELECTION_CHANNEL, BROWSER_PICKER_CANCEL_CHANNEL, BROWSER_DEVTOOLS_PAGE_EDGE_CHANNEL, BROWSER_DEVTOOLS_PAGE_EDGE_STATE_CHANNEL,
  BROWSER_MARKER_REMOVE_CHANNEL, BROWSER_MARKER_UPDATE_CHANNEL,
  type BrowserElement, type BrowserMarker, type BrowserPickerOptions
} from '../shared/browser'

const MAX_SELECTOR = 1024
const STYLE_KEYS = [
  'display', 'position', 'width', 'height', 'margin', 'padding', 'gap',
  'flex-direction', 'align-items', 'justify-content', 'grid-template-columns',
  'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
  'color', 'background-color', 'border-color', 'border-width', 'border-radius'
] as const
const OMIT_TEXT = 'input, textarea, select, script, style, noscript, [contenteditable]:not([contenteditable="false"])'

function limited(value: string, length: number): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, length)
}

export function elementSelector(element: Element): string {
  const document = element.ownerDocument
  const parts: string[] = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const tag = node.localName
    if (!/^[a-zA-Z][\w-]*$/.test(tag)) return ''
    const id = node.getAttribute('id')
    if (id && id.length <= 128 && /^[a-zA-Z_][\w-]*$/.test(id)) {
      const anchor = `#${id}`
      const selector = [anchor, ...parts].join(' > ')
      if (selector.length <= MAX_SELECTOR && document.querySelectorAll(anchor).length === 1) return selector
    }
    let index = 1
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.localName === tag) index++
    }
    parts.unshift(`${tag}:nth-of-type(${index})`)
    const selector = parts.join(' > ')
    // Never truncate CSS mid-token; an empty selector is safer than a misleading one.
    if (selector.length > MAX_SELECTOR) return ''
    if (document.querySelectorAll(selector).length === 1) return selector
  }
  return ''
}

function safeText(element: Element): string {
  if (element.closest(OMIT_TEXT)) return ''
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(OMIT_TEXT)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    }
  })
  let text = ''
  let count = 0
  for (let node = walker.nextNode(); node && count++ < 512 && text.length < 1000; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) text += ` ${node.nodeValue?.slice(0, 500) ?? ''}`
  }
  return limited(text, 500)
}

export function collectBrowserElement(element: Element): BrowserElement {
  const rect = element.getBoundingClientRect()
  const computed = element.ownerDocument.defaultView!.getComputedStyle(element)
  const styles: Record<string, string> = {}
  for (const key of STYLE_KEYS) styles[key] = limited(computed.getPropertyValue(key), 200)
  const sensitive = !!element.closest('input[type="password" i], [contenteditable]:not([contenteditable="false"])')
  const text = sensitive ? '' : safeText(element)
  return {
    selector: elementSelector(element), tagName: limited(element.localName, 64),
    role: limited(element.getAttribute('role') ?? '', 64),
    name: sensitive ? '' : limited(element.getAttribute('aria-label') ?? text, 160), text,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles
  }
}

/** Prefer below the anchor, then above; clamp even in narrow/zoomed visual viewports. */
export function pickerPosition(
  anchor: { x: number; y: number; height: number },
  panel: { width: number; height: number },
  viewport: { x: number; y: number; width: number; height: number }
): { left: number; top: number } {
  const clamp = (value: number, start: number, size: number, extent: number): number =>
    Math.max(start + 8, Math.min(value, start + extent - size - 8))
  const below = anchor.y + anchor.height + 8
  return {
    left: clamp(anchor.x, viewport.x, panel.width, viewport.width),
    top: clamp(below + panel.height <= viewport.y + viewport.height - 8 ? below : anchor.y - panel.height - 8,
      viewport.y, panel.height, viewport.height)
  }
}

function installPicker(): void {
  let documentId: string | null = null
  let active = false
  let markers: BrowserMarker[] = []
  let options: BrowserPickerOptions | undefined
  let hovered: Element | null = null
  let editing: Element | null = null
  let host: HTMLElement | null = null
  let resizeEdge: HTMLElement | null = null
  let resizeEdgeHeight = 0
  let resizeEdgeBlocked = false
  let modalObserver: MutationObserver | null = null
  let shadow: ShadowRoot | null = null
  let outline: HTMLElement | null = null
  let selectorLabel: HTMLElement | null = null
  let editor: HTMLElement | null = null
  let textarea: HTMLTextAreaElement | null = null
  let preview: HTMLElement | null = null
  let previewId: string | null = null
  let pinnedPreview = false
  let composing = false
  let frame: number | null = null
  let mutations: MutationObserver | null = null
  let resize: ResizeObserver | null = null
  let disposed = false
  const pins = new Map<string, HTMLButtonElement>()
  const markerElements = new Map<string, Element | null>()
  const observed = new Set<Element>()
  const blockedEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']
  const labels = (): BrowserPickerOptions['labels'] => options?.labels ?? {
    comment: 'Comment (optional)', add: 'Add', cancel: 'Cancel', remove: 'Delete', update: 'Update'
  }

  function closeEditor(): void {
    editing = null
    composing = false
    editor?.remove()
    editor = textarea = null
    schedule()
  }

  function closePreview(): void {
    preview?.remove()
    preview = null
    previewId = null
    pinnedPreview = false
  }

  function cancel(): void {
    const wasActive = active
    active = false
    hovered = null
    closeEditor()
    closePreview()
    if (wasActive && documentId) ipcRenderer.send(BROWSER_PICKER_CANCEL_CHANNEL, { documentId })
  }

  function reset(): void {
    active = false
    hovered = null
    closeEditor()
    closePreview()
    documentId = null
    resizeEdgeBlocked = false
    markers = []
    mutations?.disconnect()
    resize?.disconnect()
    mutations = resize = null
    observed.clear()
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    host?.remove()
    host = outline = selectorLabel = null
    shadow = null
    pins.clear()
    markerElements.clear()
    document.removeEventListener('DOMContentLoaded', mount)
  }

  function viewport(): { x: number; y: number; width: number; height: number } {
    const v = window.visualViewport
    return { x: v?.offsetLeft ?? 0, y: v?.offsetTop ?? 0, width: v?.width ?? innerWidth, height: v?.height ?? innerHeight }
  }

  function position(panel: HTMLElement, rect: DOMRect): void {
    const v = viewport()
    panel.style.maxWidth = `${Math.max(0, v.width - 16)}px`
    panel.style.maxHeight = `${Math.max(0, v.height - 16)}px`
    const size = panel.getBoundingClientRect()
    const point = pickerPosition(rect, size, v)
    panel.style.left = `${point.left}px`
    panel.style.top = `${point.top}px`
  }

  function resolve(marker: BrowserMarker): Element | null {
    if (marker.documentId !== documentId || !marker.selector || marker.selector.length > MAX_SELECTOR) return null
    if (!markerElements.has(marker.id)) {
      // A malformed/stale selector is untrusted page evidence; it must never break the overlay.
      let element: Element | null = null
      try { element = document.querySelector(marker.selector) } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'SyntaxError') throw error
      }
      markerElements.set(marker.id, element)
    }
    return markerElements.get(marker.id) ?? null
  }

  function visible(element: Element): DOMRect | null {
    if (!element.isConnected || element === host) return null
    const rect = element.getBoundingClientRect()
    const v = viewport()
    const visibility = getComputedStyle(element).visibility
    if (visibility === 'hidden' || visibility === 'collapse') return null
    return rect.width > 0 && rect.height > 0 && rect.right > v.x && rect.bottom > v.y &&
      rect.left < v.x + v.width && rect.top < v.y + v.height ? rect : null
  }

  function draw(): void {
    frame = null
    if (!host || !documentId) return
    if (!host.isConnected) { cancel(); reset(); return }
    if (editing && !editing.isConnected) closeEditor()
    if (hovered && !hovered.isConnected) hovered = null
    const target = editing ?? (active ? hovered : null)
    const rect = target && visible(target)
    if (outline && selectorLabel) {
      outline.style.display = selectorLabel.style.display = rect ? 'block' : 'none'
      if (rect && target) {
        Object.assign(outline.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
        selectorLabel.textContent = elementSelector(target)
        const v = viewport()
        const size = selectorLabel.getBoundingClientRect()
        const point = pickerPosition({ x: rect.x, y: rect.y - size.height - 16, height: 0 }, size, v)
        selectorLabel.style.left = `${point.left}px`
        selectorLabel.style.top = `${point.top}px`
      }
    }
    if (editor) {
      editor.style.display = rect ? 'block' : 'none'
      if (rect) position(editor, rect)
    }
    const nextObserved = new Set<Element>()
    if (target) nextObserved.add(target)
    const liveIds = new Set<string>()
    const occurrences = new Map<Element, number>()
    for (const marker of markers) {
      if (marker.documentId !== documentId) continue
      liveIds.add(marker.id)
      let pin = pins.get(marker.id)
      if (!pin) {
        pin = button('', () => showPreview(marker.id, true))
        pin.className = 'pin'
        pin.dataset.markerId = marker.id
        pin.addEventListener('pointerenter', () => { if (!pinnedPreview) showPreview(marker.id, false) })
        pin.addEventListener('pointerleave', () => { if (!pinnedPreview) closePreview() })
        shadow!.append(pin)
        pins.set(marker.id, pin)
      }
      pin.textContent = String(marker.ordinal)
      pin.setAttribute('aria-label', `${marker.ordinal}: ${marker.comment}`)
      const element = resolve(marker)
      const box = element && visible(element)
      pin.style.display = box ? 'block' : 'none'
      if (element) nextObserved.add(element)
      if (box && element) {
        const offset = occurrences.get(element) ?? 0
        occurrences.set(element, offset + 1)
        const v = viewport()
        pin.style.left = `${Math.max(v.x + 4, Math.min(box.right - 12 + offset * 28, v.x + v.width - 28))}px`
        pin.style.top = `${Math.max(v.y + 4, Math.min(box.y - 12, v.y + v.height - 28))}px`
      }
    }
    for (const [id, pin] of pins) if (!liveIds.has(id)) { pin.remove(); pins.delete(id); markerElements.delete(id) }
    if (previewId) {
      const marker = markers.find((item) => item.id === previewId)
      const element = marker && resolve(marker)
      const box = element && visible(element)
      if (!box || !marker) closePreview()
      else if (preview) {
        // Only the hover preview mirrors main; an open edit form keeps the user's unsaved text.
        const text = preview.querySelector('p')
        if (text) text.textContent = marker.comment
        position(preview, box)
      }
    }
    for (const element of observed) if (!nextObserved.has(element)) { resize?.unobserve(element); observed.delete(element) }
    for (const element of nextObserved) if (!observed.has(element)) { resize?.observe(element); observed.add(element) }
  }

  function schedule(): void {
    if (frame === null && documentId && host) frame = requestAnimationFrame(draw)
  }

  function button(text: string, action: () => void): HTMLButtonElement {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = text
    node.addEventListener('click', action)
    return node
  }

  function applyTheme(): void {
    const fallback: BrowserPickerOptions['theme'] = {
      background: 'Canvas', foreground: 'CanvasText', border: 'ButtonBorder', muted: 'GrayText',
      primary: 'Highlight', primaryForeground: 'HighlightText', input: 'Canvas', ring: 'Highlight', shadow: '0 6px 24px color-mix(in srgb,CanvasText 22%,transparent)', destructive: 'crimson'
    }
    for (const key of Object.keys(fallback) as (keyof typeof fallback)[]) {
      host?.style.setProperty(`--pig-${key}`, options?.theme[key] ?? fallback[key])
    }
    if (textarea) { textarea.placeholder = labels().comment; textarea.setAttribute('aria-label', labels().comment) }
    if (editor) {
      editor.querySelector('[data-add]')!.textContent = labels().add
      editor.querySelector('[data-cancel]')!.textContent = labels().cancel
    }
    if (preview) {
      for (const [selector, label] of [['[data-remove]', labels().remove], ['[data-cancel]', labels().cancel], ['[data-update]', labels().update]] as const) {
        const node = preview.querySelector(selector)
        if (node) node.textContent = label
      }
      const field = preview.querySelector('textarea')
      if (field) { field.placeholder = labels().comment; field.setAttribute('aria-label', labels().comment) }
    }
  }

  function mount(): void {
    if (!documentId || host || !document.documentElement) return
    host = document.createElement('div')
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;'
    shadow = host.attachShadow({ mode: 'closed' })
    const sheet = new CSSStyleSheet()
    // Constructed styles keep the isolated UI working on pages that reject inline <style> tags.
    sheet.replaceSync(`
      :host { font:13px/1.4 system-ui,sans-serif; color:var(--pig-foreground); }
      * { box-sizing:border-box; }
      /* Page rules targeting the host outrank :host, so fonts are set on shadow-internal nodes. */
      .panel,.pin { font:13px/1.4 system-ui,sans-serif; }
      .outline { position:fixed;pointer-events:none;border:2px solid var(--pig-ring);background:color-mix(in srgb,var(--pig-ring) 10%,transparent); }
      .selector { position:fixed;pointer-events:none;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 6px;border-radius:4px;background:var(--pig-primary);color:var(--pig-primaryForeground);font:11px/1.5 monospace; }
      .panel { position:fixed;pointer-events:auto;width:280px;padding:10px;border-radius:12px;border:1px solid var(--pig-border);background:var(--pig-background);box-shadow:var(--pig-shadow);overflow:auto;color:var(--pig-foreground); }
      textarea { display:block;resize:vertical;width:100%;min-height:72px;max-height:160px;padding:8px;border:1px solid var(--pig-border);border-radius:6px;background:var(--pig-input);color:var(--pig-foreground);font:inherit; }
      textarea::placeholder { color:var(--pig-muted); }
      textarea:focus-visible,button:focus-visible { outline:2px solid var(--pig-ring);outline-offset:2px; }
      .actions { display:flex;justify-content:flex-end;gap:6px;margin-top:8px; }
      button { pointer-events:auto;cursor:pointer;border:1px solid var(--pig-border);border-radius:6px;padding:4px 10px;background:var(--pig-background);color:var(--pig-foreground);font:inherit; }
      [data-add],[data-update],.pin { background:var(--pig-primary);color:var(--pig-primaryForeground);border-color:transparent; }
      [data-remove] { color:var(--pig-destructive);border-color:color-mix(in srgb,var(--pig-destructive) 35%,transparent);background:color-mix(in srgb,var(--pig-destructive) 8%,var(--pig-background)); }
      .pin { position:fixed;min-width:24px;height:24px;border-radius:12px;padding:0 5px;box-shadow:var(--pig-shadow); }
      p { margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere; }
    `)
    shadow.adoptedStyleSheets = [sheet]
    outline = document.createElement('div')
    outline.className = 'outline'
    selectorLabel = document.createElement('div')
    selectorLabel.className = 'selector'
    outline.style.display = selectorLabel.style.display = 'none'
    shadow.append(outline, selectorLabel)
    // Capture skips this host; stop at the shadow boundary only after controls handle events.
    for (const type of [...blockedEvents, 'keydown', 'keyup', 'keypress', 'input', 'change', 'compositionstart', 'compositionend']) {
      shadow.addEventListener(type, (event) => event.stopPropagation())
    }
    document.documentElement.append(host)
    applyTheme()
    mutations = new MutationObserver(schedule)
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    resize = new ResizeObserver(schedule)
    schedule()
  }

  function commit(): void {
    if (!documentId || !active || !editing?.isConnected || !textarea) return
    const element = collectBrowserElement(editing)
    const comment = textarea.value.slice(0, 4000)
    closeEditor()
    hovered = null
    ipcRenderer.send(BROWSER_SELECTION_CHANNEL, { documentId, element, comment })
  }

  function openEditor(element: Element): void {
    closeEditor()
    closePreview()
    editing = element
    hovered = null
    editor = document.createElement('div')
    editor.className = 'panel editor'
    textarea = document.createElement('textarea')
    textarea.maxLength = 4000
    textarea.placeholder = labels().comment
    textarea.setAttribute('aria-label', labels().comment)
    textarea.addEventListener('compositionstart', () => { composing = true })
    textarea.addEventListener('compositionend', () => { composing = false })
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
        event.preventDefault()
        commit()
      }
    })
    const actions = document.createElement('div')
    actions.className = 'actions'
    const add = button(labels().add, commit)
    add.dataset.add = ''
    const cancelButton = button(labels().cancel, closeEditor)
    cancelButton.dataset.cancel = ''
    actions.append(cancelButton, add)
    editor.append(textarea, actions)
    shadow!.append(editor)
    draw()
    textarea.focus({ preventScroll: true })
  }

  /** Hover shows the comment read-only; clicking a pin opens it for update or deletion. */
  function showPreview(id: string, pinned: boolean): void {
    const marker = markers.find((item) => item.id === id && item.documentId === documentId)
    if (!marker) return
    if (previewId === id && pinnedPreview && pinned) { closePreview(); return }
    closePreview()
    previewId = id
    pinnedPreview = pinned
    preview = document.createElement('div')
    preview.className = 'panel preview'
    if (!pinned) {
      const text = document.createElement('p')
      text.textContent = marker.comment
      preview.append(text)
    } else {
      const field = document.createElement('textarea')
      field.maxLength = 4000
      field.value = marker.comment
      field.placeholder = labels().comment
      field.setAttribute('aria-label', labels().comment)
      let typing = false
      const update = () => {
        ipcRenderer.send(BROWSER_MARKER_UPDATE_CHANNEL, { documentId, id, comment: field.value.slice(0, 4000) })
        closePreview()
      }
      field.addEventListener('compositionstart', () => { typing = true })
      field.addEventListener('compositionend', () => { typing = false })
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !typing && event.keyCode !== 229) {
          event.preventDefault()
          update()
        }
      })
      const actions = document.createElement('div')
      actions.className = 'actions'
      const remove = button(labels().remove, () => {
        ipcRenderer.send(BROWSER_MARKER_REMOVE_CHANNEL, { documentId, id })
        closePreview()
      })
      remove.dataset.remove = ''
      const cancelButton = button(labels().cancel, closePreview)
      cancelButton.dataset.cancel = ''
      const save = button(labels().update, update)
      save.dataset.update = ''
      actions.append(remove, cancelButton, save)
      preview.append(field, actions)
    }
    shadow!.append(preview)
    draw()
    preview.querySelector('textarea')?.focus({ preventScroll: true })
  }

  function ownEvent(event: Event): boolean {
    return !!host && event.composedPath().includes(host)
  }

  function target(event: Event): Element | null {
    const element = event.target
    return !ownEvent(event) && !(resizeEdge && event.composedPath().includes(resizeEdge)) &&
      element instanceof Element && element.ownerDocument === document &&
      element.getRootNode() === document ? element : null
  }

  function onMove(event: Event): void {
    if (!active || editing || ownEvent(event)) return
    hovered = target(event)
    schedule()
  }

  function onClick(event: Event): void {
    if (!active || ownEvent(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.type !== 'click') return
    const element = target(event)
    if (element?.isConnected && documentId) openEditor(element)
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || (!active && !previewId)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (editing) closeEditor()
    else if (previewId) closePreview()
    else cancel()
    schedule()
  }

  function onCommand(_event: Electron.IpcRendererEvent, command: unknown): void {
    if (disposed || !command || typeof command !== 'object') return
    const { active: enabled, documentId: id, markers: nextMarkers, options: nextOptions } = command as {
      active?: unknown; documentId?: unknown; markers?: BrowserMarker[]; options?: BrowserPickerOptions
    }
    if (typeof enabled !== 'boolean' || typeof id !== 'string' || !id || id.length > 256) return
    if (id !== documentId) reset()
    documentId = id
    active = enabled
    markers = nextMarkers ?? []
    if (nextOptions) options = nextOptions
    if (!active) { hovered = null; closeEditor(); closePreview() }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
    else mount()
    applyTheme()
    syncResizeEdge()
    schedule()
  }

  function syncResizeEdge(): void {
    if (resizeEdgeHeight === 0) {
      resizeEdge?.remove()
      resizeEdge = null
      modalObserver?.disconnect()
      modalObserver = null
      document.removeEventListener('DOMContentLoaded', syncResizeEdge)
      return
    }
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', syncResizeEdge, { once: true })
      return
    }
    if (!modalObserver) {
      modalObserver = new MutationObserver(syncResizeEdge)
      modalObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
    }
    const blocked = document.querySelector(':modal') !== null
    if (blocked !== resizeEdgeBlocked && documentId) {
      resizeEdgeBlocked = blocked
      ipcRenderer.send(BROWSER_DEVTOOLS_PAGE_EDGE_STATE_CHANNEL, { documentId, blocked })
    }
    if (blocked) {
      resizeEdge?.remove()
      resizeEdge = null
      return
    }
    if (!resizeEdge) {
      resizeEdge = document.createElement('div')
      resizeEdge.dataset.pigDevtoolsResize = ''
      resizeEdge.setAttribute('aria-hidden', 'true')
      resizeEdge.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;left:0!important;right:0!important;bottom:0!important;box-sizing:border-box!important;pointer-events:auto!important;cursor:row-resize!important;background:transparent!important;z-index:2147483647!important;'
    }
    if (resizeEdge.style.height !== `${resizeEdgeHeight}px`) resizeEdge.style.setProperty('height', `${resizeEdgeHeight}px`, 'important')
    if (!resizeEdge.isConnected) document.documentElement.append(resizeEdge)
  }

  function onResizeEdge(_event: Electron.IpcRendererEvent, height: unknown): void {
    if (disposed || typeof height !== 'number' || !Number.isFinite(height) || height < 0) return
    resizeEdgeHeight = height
    syncResizeEdge()
  }

  function cleanup(): void {
    cancel()
    reset()
    resizeEdge?.remove()
    resizeEdge = null
    modalObserver?.disconnect()
    modalObserver = null
    document.removeEventListener('DOMContentLoaded', syncResizeEdge)
  }

  function dispose(): void {
    cleanup()
    disposed = true
    ipcRenderer.removeListener(BROWSER_PICKER_CHANNEL, onCommand)
    ipcRenderer.removeListener(BROWSER_DEVTOOLS_PAGE_EDGE_CHANNEL, onResizeEdge)
    for (const type of blockedEvents) window.removeEventListener(type, onClick, true)
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('scroll', schedule)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('beforeunload', cancel)
  }

  function onPageHide(event: PageTransitionEvent): void {
    // BFCache restores this context; its command listeners survive navigation cleanup.
    if (event.persisted) cleanup()
    else dispose()
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) syncResizeEdge()
  }

  for (const type of blockedEvents) window.addEventListener(type, onClick, { capture: true, passive: false })
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('scroll', schedule)
  ipcRenderer.on(BROWSER_PICKER_CHANNEL, onCommand)
  ipcRenderer.on(BROWSER_DEVTOOLS_PAGE_EDGE_CHANNEL, onResizeEdge)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  // beforeunload is cancellable; keep the resize surface until pagehide confirms departure.
  window.addEventListener('beforeunload', cancel)
}

if (process.isMainFrame) installPicker()
