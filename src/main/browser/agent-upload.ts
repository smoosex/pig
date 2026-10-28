/** Explicit local files cross only the main/CDP boundary. Approval binds their canonical paths and
 * the original isolated-world input; no paths or file contents are sent into the page script. */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { WebContents } from 'electron'
import { AGENT_WORLD_ID } from './agent-snapshot'
import { waitForBrowserOperation, withBrowserDebugger } from './browser-debugger'
import { executeBrowserScript } from './browser-script'

/** Element-child index and tag of one step; a new segment starts at an open shadow root. */
type UploadStep = [index: number, localName: string]

/** Self-contained in world 1207. Pin both the ref map and the actual element across approval. */
function resolveUploadInput(ref: string, count: number, token: string, expected?: UploadStep[][]): UploadStep[][] {
  const scope = globalThis as unknown as {
    __pigAgentRefs?: Map<string, Element>
    __pigUploadPins?: Map<string, { refs: Map<string, Element>; input: Element }>
  }
  const refs = scope.__pigAgentRefs
  const input = refs?.get(ref)
  if (!refs || !input || !input.isConnected || input.ownerDocument !== document) throw new Error('Missing or stale browser ref; take a new browser_snapshot')
  if (expected) {
    const pin = scope.__pigUploadPins?.get(token)
    if (!pin || pin.refs !== refs || pin.input !== input) throw new Error('Browser file input ref changed; take a new browser_snapshot')
  }
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
  if (expected && JSON.stringify(segments) !== JSON.stringify(expected)) throw new Error('Browser file input moved; take a new browser_snapshot')
  if (!expected) (scope.__pigUploadPins ??= new Map()).set(token, { refs, input })
  return segments
}

function releaseUploadPin(token: string): void {
  ;(globalThis as unknown as { __pigUploadPins?: Map<string, unknown> }).__pigUploadPins?.delete(token)
}

interface CdpNode { backendNodeId: number; nodeType: number; nodeName: string; localName?: string; attributes?: string[]; children?: CdpNode[]; shadowRoots?: (CdpNode & { shadowRootType?: string })[] }

export interface BrowserUploadFile {
  requested: string
  resolved: string
  size: number
}
interface CheckedFile extends BrowserUploadFile {
  dev: number
  ino: number
  mtimeMs: number
  ctimeMs: number
}

export type BrowserUploadApproval = (files: readonly BrowserUploadFile[], signal?: AbortSignal) => Promise<void>

export function uploadBrowserFiles(
  contents: WebContents, ref: string, files: readonly string[], approve: BrowserUploadApproval,
  signal: AbortSignal | undefined, assertCurrent: () => void
): Promise<void> {
  return waitForBrowserOperation(performUpload(contents, ref, files, approve, signal, assertCurrent), signal)
}

async function performUpload(
  contents: WebContents, ref: string, files: readonly string[], approve: BrowserUploadApproval,
  signal: AbortSignal | undefined, assertCurrent: () => void
): Promise<void> {
  const check = () => { signal?.throwIfAborted(); assertCurrent() }
  const checked = async <T>(start: () => Promise<T>): Promise<T> => {
    check()
    const value = await start()
    check()
    return value
  }
  // Filesystem errors can contain canonical local paths; do not return those to the model.
  const resolvePath = (path: string) => checked(async () => {
    try { return await realpath(path) } catch { throw new Error('Cannot resolve an upload file') }
  })
  const fileStat = (path: string) => checked(async () => {
    try { return await stat(path) } catch { throw new Error('Cannot inspect an upload file') }
  })
  const verify = async (file: CheckedFile) => {
    if (await resolvePath(file.requested) !== file.resolved || await resolvePath(file.resolved) !== file.resolved) {
      throw new Error('An upload file path changed; request approval again')
    }
    const info = await fileStat(file.resolved)
    if (!info.isFile() || info.dev !== file.dev || info.ino !== file.ino || info.size !== file.size ||
      info.mtimeMs !== file.mtimeMs || info.ctimeMs !== file.ctimeMs) {
      throw new Error('An upload file changed; request approval again')
    }
  }
  check()
  if (!ref) throw new Error('Browser ref is required')
  if (files.length < 1 || files.length > 20) throw new Error('File upload requires 1 to 20 files')
  const paths = [...files]
  if (paths.some(path => !isAbsolute(path))) throw new Error('File upload requires absolute paths')
  const checkedFiles: CheckedFile[] = []
  for (const requested of paths) {
    const resolved = await resolvePath(requested)
    const info = await fileStat(resolved)
    if (!info.isFile()) throw new Error('File upload supports only regular files')
    checkedFiles.push({ requested, resolved, size: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })
  }
  const token = randomUUID()
  const resolve = (expected?: UploadStep[][]) => checked(() => executeBrowserScript<UploadStep[][]>(contents, AGENT_WORLD_ID,
    `(${resolveUploadInput.toString()})(${JSON.stringify(ref)}, ${paths.length}, ${JSON.stringify(token)}, ${JSON.stringify(expected)})`))
  try {
    const segments = await withBrowserDebugger(contents, () => resolve())
    // The debugger queue is deliberately free while the user considers the request.
    await checked(() => waitForBrowserOperation(approve(checkedFiles, signal), signal))
    for (const file of checkedFiles) await verify(file)
    await checked(() => withBrowserDebugger(contents, async api => {
      const command = (method: string, params: Record<string, unknown>) => checked(() => api.sendCommand(method, params))
      const describe = async (backendNodeId: number): Promise<CdpNode> =>
        (await command('DOM.describeNode', { backendNodeId, depth: 1, pierce: true })).node
      // Reject a replacement even if a new snapshot reused the same ref and child position.
      await resolve(segments)
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
      for (const file of checkedFiles) await verify(file)
      await resolve(segments)
      await command('DOM.setFileInputFiles', { backendNodeId: node.backendNodeId, files: checkedFiles.map(file => file.resolved) })
    }))
  } finally {
    // Do not turn a completed upload into a retry when cleanup fails; navigation destroys the old world.
    void executeBrowserScript(contents, AGENT_WORLD_ID, `(${releaseUploadPin.toString()})(${JSON.stringify(token)})`).catch(error => {
      if (!signal?.aborted && !contents.isDestroyed()) console.error('Browser upload ref cleanup failed:', error)
    })
  }
}
