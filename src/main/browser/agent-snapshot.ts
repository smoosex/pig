/**
 * Accessibility-style page outline for the agent, evaluated in an isolated world of the page's main frame.
 *
 * `snapshotPage` is serialized with Function#toString, so it must stay self-contained: no imports,
 * closures or helpers from this module. Interactive elements get refs (`e1`, `e2`, …) kept in the
 * isolated world, which the page cannot read; each snapshot replaces the previous refs and a
 * navigation discards the world. Form values are included except password fields.
 */
export interface PageSnapshot {
  text: string
  refs: number
  truncated: boolean
}

export const AGENT_WORLD_ID = 1207

export function snapshotPage(limit: number): PageSnapshot {
  const refs = new Map<string, Element>()
  ;(globalThis as unknown as { __pigAgentRefs?: Map<string, Element> }).__pigAgentRefs = refs
  const lines: string[] = []
  let size = 0
  let truncated = false
  const clean = (value: string | null | undefined, max: number) => {
    const text = (value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
  }
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const emit = (depth: number, line: string) => {
    if (truncated) return
    if (size + line.length > limit) { truncated = true; return }
    lines.push(`${'  '.repeat(depth)}- ${line}`)
    size += line.length + depth * 2 + 3
  }
  const interactive = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem'])
  const containers = new Set(['main', 'navigation', 'banner', 'contentinfo', 'form', 'dialog', 'alertdialog', 'list',
    'listitem', 'table', 'row', 'region', 'complementary', 'menu', 'menubar', 'tablist', 'tabpanel', 'tree', 'grid', 'group'])
  const inputRoles: Record<string, string> = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
    submit: 'button', button: 'button', reset: 'button', image: 'button'
  }
  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
      return type === 'hidden' ? '' : inputRoles[type] ?? 'textbox'
    }
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return el.getAttribute('alt') ? 'img' : ''
    const roles: Record<string, string> = {
      nav: 'navigation', main: 'main', form: 'form', dialog: 'dialog', ul: 'list', ol: 'list', li: 'listitem',
      table: 'table', tr: 'row', aside: 'complementary', details: 'group', header: 'banner', footer: 'contentinfo'
    }
    if ((tag === 'header' || tag === 'footer') && el.parentElement?.closest('article, section, main, nav, aside')) return ''
    if (tag === 'section') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : ''
    return roles[tag] ?? ''
  }
  const roleOf = (el: Element) => (el.getAttribute('role') ?? '').trim().split(/\s+/)[0] || implicitRole(el)
  const textOf = (el: Element) => clean((el as HTMLElement).innerText ?? el.textContent, 160)
  const nameOf = (el: Element, role: string): string => {
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
      if (clean(text, 160)) return clean(text, 160)
    }
    const label = el.getAttribute('aria-label')
    if (clean(label, 160)) return clean(label, 160)
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const labels = Array.from(el.labels ?? []).map((item) => item.textContent).join(' ')
      if (clean(labels, 160)) return clean(labels, 160)
      if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value, 160)
      return clean(el.getAttribute('placeholder') ?? el.getAttribute('title'), 160)
    }
    if (el.tagName === 'IMG') return clean(el.getAttribute('alt'), 160)
    if (interactive.has(role) || role === 'heading') return textOf(el) || clean(el.getAttribute('title'), 160)
    return clean(el.getAttribute('title'), 160)
  }
  const hidden = (el: Element): boolean => {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    return style.display !== 'contents' && el.getClientRects().length === 0
  }
  const describe = (el: Element, role: string): string => {
    const name = nameOf(el, role)
    let line = name ? `${role} ${quote(name)}` : role
    if (role === 'heading') line += ` [level=${/^H([1-6])$/.exec(el.tagName)?.[1] ?? el.getAttribute('aria-level') ?? '2'}]`
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.checked) line += ' [checked]'
    } else if (el.getAttribute('aria-checked') === 'true') line += ' [checked]'
    if (el.getAttribute('aria-expanded')) line += ` [expanded=${el.getAttribute('aria-expanded')}]`
    if (el.getAttribute('aria-selected') === 'true') line += ' [selected]'
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]'
    if (interactive.has(role)) {
      const ref = `e${refs.size + 1}`
      refs.set(ref, el)
      line += ` [ref=${ref}]`
    }
    if (el instanceof HTMLInputElement && el.type === 'password') {
      if (el.value) line += ' value=(hidden)'
    } else if ((el instanceof HTMLInputElement && ['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox'].includes(role)) || el instanceof HTMLTextAreaElement) {
      if (el.value) line += ` value=${quote(clean(el.value, 200))}`
    } else if (el instanceof HTMLSelectElement) {
      const selected = Array.from(el.selectedOptions).map((option) => clean(option.textContent, 80)).join(', ')
      if (selected) line += ` value=${quote(selected)}`
    } else if ((el as HTMLElement).isContentEditable && role === 'textbox') {
      line += ` value=${quote(textOf(el))}`
    }
    if (role === 'link') {
      const href = el.getAttribute('href') ?? ''
      if (href && !href.startsWith('javascript:')) line += ` href=${quote(clean(href, 200))}`
    }
    return line
  }
  const walk = (parent: ParentNode, depth: number, pending?: { text: string }) => {
    const buffer = pending ?? { text: '' }
    const flush = () => {
      const value = clean(buffer.text, 400)
      if (value) emit(depth, `text: ${value}`)
      buffer.text = ''
    }
    for (const node of Array.from(parent.childNodes)) {
      if (truncated) return
      if (node.nodeType === Node.TEXT_NODE) { buffer.text += ` ${node.textContent ?? ''}`; continue }
      if (!(node instanceof Element)) continue
      const tag = node.tagName.toLowerCase()
      if (['script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link'].includes(tag)) continue
      if (hidden(node)) continue
      if (tag === 'iframe' || tag === 'frame') { flush(); emit(depth, 'iframe (content not included)'); continue }
      let role = roleOf(node)
      if (!role && (node as HTMLElement).isContentEditable && !node.parentElement?.isContentEditable) role = 'textbox'
      if (role === 'presentation' || role === 'none') role = ''
      if (!role && node.getAttribute('tabindex') !== null && Number(node.getAttribute('tabindex')) >= 0 && node.hasAttribute('onclick')) role = 'button'
      if (interactive.has(role) || role === 'heading' || role === 'img') {
        flush()
        emit(depth, describe(node, role))
        continue
      }
      if (containers.has(role)) {
        flush()
        const name = nameOf(node, role)
        emit(depth, name ? `${role} ${quote(name)}` : role)
        walk(node, depth + 1)
        if (node.shadowRoot) walk(node.shadowRoot, depth + 1)
        continue
      }
      // Plain inline wrappers (<b>, <span>…) stay in the surrounding sentence; block boundaries end it.
      const display = getComputedStyle(node).display
      const inline = !display || display.startsWith('inline')
      if (inline && !node.shadowRoot &&
          !node.querySelector('a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex],img[alt],iframe,h1,h2,h3,h4,h5,h6')) {
        walk(node, depth, buffer)
        continue
      }
      // Text before a nested element must be emitted before that element's own lines.
      flush()
      walk(node, depth)
      if (node.shadowRoot) walk(node.shadowRoot, depth)
    }
    if (!pending) flush()
  }
  if (document.body) walk(document.body, 0)
  return { text: lines.join('\n'), refs: refs.size, truncated }
}
