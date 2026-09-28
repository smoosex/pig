/* The SDK's RPC mode does not provide a UI when sessions are created directly. Pig supplies the supported dialog and notification methods here. */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent'
import type { PluginUIEvent } from '../../shared/api'

interface PromptWaiter {
  sessionId: string
  sender: WebContents
  finish: (value: string | boolean | null) => void
}

const waiters = new Map<string, PromptWaiter>()

// Pi copies the UI context when binding extensions, so terminal-only theme errors must not fire on property access.
const terminalTheme = new Proxy({} as ExtensionUIContext['theme'], {
  get() { throw new Error('Terminal themes are unavailable in Pig RPC mode') }
})

export function replyPluginUI(sender: WebContents, id: string, value: string | boolean | null): void {
  const waiter = waiters.get(id)
  if (!waiter || waiter.sender !== sender) return
  waiter.finish(value)
}

export function cancelPluginPrompts(sessionId: string): void {
  for (const waiter of waiters.values()) {
    if (waiter.sessionId === sessionId) waiter.finish(null)
  }
}

export function createPluginUI(sessionId: string, win: BrowserWindow): ExtensionUIContext {
  const send = (event: PluginUIEvent): boolean => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return false
    win.webContents.send('plugins:ui', event)
    return true
  }
  const prompt = (
    method: 'select' | 'confirm' | 'input' | 'editor',
    title: string,
    details: Partial<Extract<PluginUIEvent, { kind: 'prompt' }>> = {},
    opts?: ExtensionUIDialogOptions
  ): Promise<string | boolean | null> => {
    if (opts?.signal?.aborted) return Promise.resolve(null)
    const id = randomUUID()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: string | boolean | null) => {
        if (!waiters.delete(id)) return
        if (timer) clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
        send({ kind: 'dismiss', id, sessionId })
        resolve(value)
      }
      const onAbort = () => finish(null)
      waiters.set(id, { sessionId, sender: win.webContents, finish })
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts?.timeout && opts.timeout > 0) timer = setTimeout(onAbort, opts.timeout)
      if (!send({ kind: 'prompt', id, sessionId, method, title, ...details })) finish(null)
    })
  }
  return {
    select: async (title, options, opts) => {
      const answer = await prompt('select', title, { options }, opts)
      return typeof answer === 'string' && options.includes(answer) ? answer : undefined
    },
    confirm: async (title, message, opts) => (await prompt('confirm', title, { message }, opts)) === true,
    input: async (title, placeholder, opts) => {
      const answer = await prompt('input', title, { message: placeholder }, opts)
      return typeof answer === 'string' ? answer : undefined
    },
    editor: async (title, prefill) => {
      const answer = await prompt('editor', title, { prefill })
      return typeof answer === 'string' ? answer : undefined
    },
    notify: (message, level = 'info') => { send({ kind: 'notify', sessionId, message, level }) },
    setStatus: (key, text) => { send({ kind: 'status', sessionId, key, text }) },
    setWidget: (key, content) => {
      if (!content || Array.isArray(content)) send({ kind: 'widget', sessionId, key, lines: content })
    },
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>() => undefined as T,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: terminalTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Terminal themes are unavailable in Pig' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {}
  }
}
