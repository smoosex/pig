/** Serialized into the agent's isolated world; CSS selectors are data, never executable code. */
import type { BrowserWaitOptions } from '../plugins/pig-browser-host'

export function pageElementMatches(options: BrowserWaitOptions): boolean {
  let element: Element | null
  if (options.ref) {
    const refs = (globalThis as unknown as { __pigAgentRefs?: Map<string, Element> }).__pigAgentRefs
    const found = refs?.get(options.ref)
    if (!found) throw new Error('Unknown browser ref; take a new browser_snapshot')
    element = found
  } else {
    element = document.querySelector(options.selector!)
  }
  const attached = !!element?.isConnected
  const visible = attached && !element!.closest('[hidden], [aria-hidden="true"]') &&
    getComputedStyle(element!).display !== 'none' && getComputedStyle(element!).visibility !== 'hidden' &&
    element!.getClientRects().length > 0
  switch (options.state ?? 'visible') {
    case 'attached': return attached
    case 'detached': return !attached
    case 'visible': return !!visible
    case 'hidden': return !visible
  }
}
