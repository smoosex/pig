/** Explicit local files cross only the main/CDP boundary. Serialized ref validation never receives
 * paths; debugger ownership outlives cancellation until outstanding filesystem/page/CDP work settles. */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { WebContents } from 'electron'
import { AGENT_WORLD_ID } from './agent-snapshot'
import { withBrowserDebugger } from './browser-debugger'
import { executeBrowserScript } from './browser-script'

/** Element-child index and tag of one step; a new segment starts at an open shadow root. */
type UploadStep = [index: number, localName: string]

/** Self-contained in world 1207. Each segment starts at a document or an open shadow root and addresses
 * nodes by exact element-child position, so no selector can match a different node first. */
function resolveUploadInput(ref: string, count: number, expected?: UploadStep[][]): UploadStep[][] {
  const refs = (globalThis as unknown as { __pigAgentRefs?: Map<string, Element> }).__pigAgentRefs
  const input = refs?.get(ref)
  if (!input || !input.isConnected || input.ownerDocument !== document) throw new Error('Missing or stale browser ref; take a new browser_snapshot')
  if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('Browser ref is not an input[type=file]')
  if (input.matches(':disabled') || input.closest('[aria-disabled="true"],[inert]')) throw new Error('Browser file input is disabled')
  if (input.hasAttribute('webkitdirectory')) throw new Error('Directory upload is not supported')
  if (!input.multiple && count !== 1) throw new Error('File input requires exactly one file without multiple')
  const segments: UploadStep[][] = []
  let element: Element = input
  while (true) {
    const steps: UploadStep[] = []
    let parent: ParentNode
    while (true) {
      parent = element.parentNode as ParentNode
      steps.unshift([Array.prototype.indexOf.call(parent.children, element), element.localName])
      if (!(parent instanceof Element)) break
      element = parent
    }
    segments.unshift(steps)
    if (parent === document) break
    if (!(parent instanceof ShadowRoot) || parent.mode !== 'open' || parent.host.shadowRoot !== parent) throw new Error('Only the main document and open shadow roots support file upload')
    element = parent.host
  }
  if (expected && JSON.stringify(segments) !== JSON.stringify(expected)) {
    throw new Error('Browser file input moved; take a new browser_snapshot')
  }
  return segments
}

interface CdpNode { backendNodeId: number; nodeType: number; nodeName: string; localName?: string; attributes?: string[]; children?: CdpNode[]; shadowRoots?: (CdpNode & { shadowRootType?: string })[] }

export async function uploadBrowserFiles(
  contents: WebContents, ref: string, files: readonly string[], signal: AbortSignal | undefined,
  assertCurrent: () => void
): Promise<void> {
  const check = () => { signal?.throwIfAborted(); assertCurrent() }
  const checked = async <T>(start: () => Promise<T>): Promise<T> => {
    check()
    const value = await start()
    check()
    return value
  }
  check()
  if (!ref) throw new Error('Browser ref is required')
  if (files.length < 1 || files.length > 20) throw new Error('File upload requires 1 to 20 files')
  const paths = [...files]
  if (paths.some(path => !isAbsolute(path))) throw new Error('File upload requires absolute paths')
  await checked(() => withBrowserDebugger(contents, async api => {
    const realPaths: string[] = []
    for (const path of paths) {
      const resolved = await checked(() => realpath(path))
      const info = await checked(() => stat(resolved))
      if (!info.isFile()) throw new Error('File upload supports only regular files')
      realPaths.push(resolved)
    }
    const resolve = (expected?: UploadStep[][]) => checked(() => executeBrowserScript<UploadStep[][]>(contents, AGENT_WORLD_ID,
      `(${resolveUploadInput.toString()})(${JSON.stringify(ref)}, ${paths.length}, ${JSON.stringify(expected)})`))
    const segments = await resolve()
    const command = (method: string, params: Record<string, unknown>) => checked(() => api.sendCommand(method, params))
    const describe = async (backendNodeId: number): Promise<CdpNode> =>
      (await command('DOM.describeNode', { backendNodeId, depth: 1, pierce: true })).node
    const { root } = await command('DOM.getDocument', { depth: 0 })
    let node = await describe(root.backendNodeId)
    for (let index = 0; index < segments.length; index++) {
      if (index > 0) {
        const shadow = node.shadowRoots?.find(item => item.shadowRootType === 'open')
        if (!shadow) throw new Error('Browser open shadow root no longer exists; take a new browser_snapshot')
        node = await describe(shadow.backendNodeId)
      }
      for (const [position, localName] of segments[index]) {
        const child = node.children?.filter(item => item.nodeType === 1)[position]
        if (!child || child.localName !== localName) throw new Error('Browser file input no longer exists; take a new browser_snapshot')
        node = await describe(child.backendNodeId)
      }
    }
    let type: string | undefined
    for (let index = 0; node.attributes && index < node.attributes.length; index += 2) {
      if (node.attributes[index].toLowerCase() === 'type') type = node.attributes[index + 1]
    }
    if (node.nodeType !== 1 || node.nodeName !== 'INPUT' || type?.toLowerCase() !== 'file') throw new Error('CDP target is not an input[type=file]')
    // Validate the original ref, not a fresh lookup: a replacement at the same position is not consent.
    await resolve(segments)
    await command('DOM.setFileInputFiles', { backendNodeId: node.backendNodeId, files: realPaths })
  }, signal))
}
