/** Dialog promises are owned by a window and session/action; timeout, reload and window teardown cancel them. */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { ExtensionUIEvent } from '../shared/api'
import { mcpSdk } from './mcp/sdk'

const requests = new Map<
  string,
  { owner: string; sender: WebContents; finish(value: string | null): void }
>()
export function replyExtensionUI(sender: WebContents, id: string, value: string | null): void {
  const request = requests.get(id)
  if (request?.sender === sender && (value === null || typeof value === 'string'))
    request.finish(value)
}
export function cancelExtensionUI(owner: string): void {
  for (const request of requests.values()) if (request.owner === owner) request.finish(null)
}
export function openMcpUrl(value: string): Promise<void> {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Only HTTP(S) authorization URLs are allowed')
  return import('electron').then(({ shell }) => shell.openExternal(url.href))
}
export async function createExtensionUI(
  win: BrowserWindow,
  owner: string
): Promise<ExtensionUIContext> {
  const { theme } = await mcpSdk()
  const send = (event: ExtensionUIEvent) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send('extensions:ui', event)
  }
  const prompt = (
    fields: Omit<Extract<ExtensionUIEvent, { kind: 'prompt' }>, 'kind' | 'id' | 'owner'>,
    opts?: { timeout?: number; signal?: AbortSignal }
  ): Promise<string | undefined> => {
    if (win.isDestroyed() || win.webContents.isDestroyed() || opts?.signal?.aborted)
      return Promise.resolve(undefined)
    const sender = win.webContents
    const id = randomUUID()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cancel = () => finish(null)
      const finish = (value: string | null) => {
        if (!requests.delete(id)) return
        if (timer) clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', cancel)
        sender.removeListener('destroyed', cancel)
        send({ kind: 'dismiss', id })
        resolve(
          value !== null && (!fields.options || fields.options.includes(value)) ? value : undefined
        )
      }
      requests.set(id, { owner, sender, finish })
      sender.once('destroyed', cancel)
      opts?.signal?.addEventListener('abort', cancel, { once: true })
      if (opts?.timeout !== undefined) timer = setTimeout(cancel, opts.timeout)
      send({ kind: 'prompt', id, owner, ...fields })
    })
  }
  return {
    select: (title, options, opts) => prompt({ method: 'select', title, options }, opts),
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
