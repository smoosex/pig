/** Dialog promises are owned by a window and session/action; timeout, reload and window teardown cancel them. */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents, Event, WebContentsDidStartNavigationEventParams } from 'electron'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { ExtensionUIEvent } from '../shared/api'
import { mcpSdk } from './mcp/sdk'

type Scope = 'extension' | 'process'
const requests = new Map<
  string,
  { owner: string; scope: Scope; sender: WebContents; finish(value: string | null): void }
>()

// One set of listeners per window, installed before the asynchronous SDK load. A context
// cannot miss a navigation that finishes before that load resolves.
const windows = new WeakMap<WebContents, { ready: boolean; generation: number }>()
function trackWindow(sender: WebContents) {
  let state = windows.get(sender)
  if (state) return state
  state = { ready: !sender.isDestroyed(), generation: 0 }
  windows.set(sender, state)
  const tracked = state
  const suspend = () => {
    tracked.ready = false
    tracked.generation++
    for (const request of requests.values()) if (request.sender === sender) request.finish(null)
  }
  const navigate = (event: Event<WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument) suspend()
  }
  const ready = () => { tracked.ready = true }
  const destroyed = () => {
    suspend()
    sender.removeListener('did-start-navigation', navigate)
    sender.removeListener('render-process-gone', suspend)
    sender.removeListener('dom-ready', ready)
    sender.removeListener('destroyed', destroyed)
  }
  if (!sender.isDestroyed()) {
    sender.on('did-start-navigation', navigate)
    sender.on('render-process-gone', suspend)
    sender.on('dom-ready', ready)
    sender.once('destroyed', destroyed)
  }
  return state
}
export function replyExtensionUI(sender: WebContents, id: string, value: string | null): void {
  const request = requests.get(id)
  if (request?.sender === sender && (value === null || typeof value === 'string'))
    request.finish(value)
}
export function cancelExtensionUI(owner: string, scope?: Scope): void {
  for (const request of requests.values())
    if (request.owner === owner && (scope === undefined || request.scope === scope)) request.finish(null)
}
export function openMcpUrl(value: string): Promise<void> {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Only HTTP(S) authorization URLs are allowed')
  return import('electron').then(({ shell }) => shell.openExternal(url.href))
}
export async function createExtensionUI(
  win: BrowserWindow,
  owner: string,
  scope: Scope = 'extension'
): Promise<ExtensionUIContext> {
  const sender = win.webContents
  const state = trackWindow(sender)
  const generation = state.generation
  const wasReady = state.ready
  const { theme } = await mcpSdk()
  const createdInDocument = wasReady && state.generation === generation
  const available = () => createdInDocument && state.ready && !win.isDestroyed() && !sender.isDestroyed()
  const send = (event: ExtensionUIEvent) => {
    if (available()) sender.send('extensions:ui', event)
  }
  const prompt = (
    fields: Omit<Extract<ExtensionUIEvent, { kind: 'prompt' }>, 'kind' | 'id' | 'owner'>,
    opts?: { timeout?: number; signal?: AbortSignal }
  ): Promise<string | undefined> => {
    if (!available() || opts?.signal?.aborted)
      return Promise.resolve(undefined)
    const id = randomUUID()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cancel = () => finish(null)
      const finish = (value: string | null) => {
        if (!requests.delete(id)) return
        if (timer) clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', cancel)
        send({ kind: 'dismiss', id })
        resolve(
          value !== null && (!fields.options || fields.options.includes(value)) ? value : undefined
        )
      }
      requests.set(id, { owner, scope, sender, finish })
      opts?.signal?.addEventListener('abort', cancel, { once: true })
      if (opts?.timeout !== undefined) timer = setTimeout(cancel, opts.timeout)
      send({ kind: 'prompt', id, owner, ...fields })
    })
  }
  return {
    select: (title, options, opts) => {
      // Pi forwards the options object unchanged, so the permission layer can mark its requests.
      const approval = (opts as { approval?: { message?: unknown } } | undefined)?.approval
      return prompt({ method: 'select', title, options, ...(approval && typeof approval.message === 'string'
        ? { approval: true as const, message: approval.message } : {}) }, opts)
    },
    confirm: async (title, message, opts) =>
      (await prompt({ method: 'confirm', title, message }, opts)) === 'yes',
    input: (title, placeholder, opts) =>
      prompt({ method: 'input', title, message: placeholder }, opts),
    editor: (title, prefill) => prompt({ method: 'editor', title, prefill }),
    notify: (message, level = 'info') => send({ kind: 'notify', owner, message, level }),
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWidget: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    async custom<T>() {
      return undefined as T
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return theme.theme
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Pig owns its theme' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {}
  }
}
