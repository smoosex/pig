/** Observe viewport and nested scrolling in the agent world; bounded host polling stays cancellable. */
import type { WebContents } from 'electron'
import { AGENT_WORLD_ID } from './agent-snapshot'
import { executeBrowserScript } from './browser-script'

export function browserMotionState(point?: { x: number; y: number }): string {
  const scope = globalThis as unknown as { __pigBrowserMotion?: { revision: number; targets: Element[] } }
  if (!scope.__pigBrowserMotion) {
    const state = { revision: 0, targets: [] as Element[] }
    scope.__pigBrowserMotion = state
    const changed = () => { state.revision++ }
    // Capture scroll on any container, not only document.scrollingElement.
    addEventListener('scroll', changed, true)
    addEventListener('resize', changed)
    window.visualViewport?.addEventListener('scroll', changed)
    window.visualViewport?.addEventListener('resize', changed)
  }
  const state = scope.__pigBrowserMotion
  if (point) {
    state.targets = []
    let element = document.elementFromPoint(point.x, point.y)
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(point.x, point.y)
      if (!inner || inner === element) break
      element = inner
    }
    // Scroll events inside shadow roots are not composed. Sample the wheel target's ancestors too.
    while (element) {
      state.targets.push(element)
      const root = element.getRootNode()
      element = element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
    }
  }
  state.targets = state.targets.filter(element => element.isConnected)
  return JSON.stringify([state.revision, innerWidth, innerHeight, scrollX, scrollY,
    devicePixelRatio, window.visualViewport?.offsetLeft, window.visualViewport?.offsetTop, window.visualViewport?.scale,
    state.targets.map(element => [element.scrollLeft, element.scrollTop])])
}

export function readBrowserMotion(contents: WebContents, point?: { x: number; y: number }): Promise<string> {
  return executeBrowserScript<string>(contents, AGENT_WORLD_ID, `(${browserMotionState.toString()})(${JSON.stringify(point) ?? ''})`)
}

export async function waitForBrowserMotion(contents: WebContents, check: () => void): Promise<void> {
  const deadline = performance.now() + 3000
  let previous: string | undefined
  let quietSince = performance.now()
  while (true) {
    check()
    const state = await readBrowserMotion(contents)
    check()
    if (typeof state !== 'string') throw new Error('Invalid browser motion state')
    const now = performance.now()
    if (state !== previous) { previous = state; quietSince = now }
    else if (now - quietSince >= 150) return
    if (now >= deadline) throw new Error('Browser viewport or scroll did not settle; inspect the page before retrying')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
