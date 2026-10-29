/** Route only permission selects to the child's parent; ordinary child extension UI stays disabled. */
import type { BrowserWindow } from 'electron'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { createExtensionUI } from '../extension-ui'
import type { RunSpec } from './runner'

function displayTitle(title: string): string {
  const escaped = title.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const chars = Array.from(escaped.trim())
  return chars.length > 100 ? `${chars.slice(0, 99).join('')}…` : chars.join('') || 'Subagent'
}

export function subagentApprovalUI(
  spec: Pick<RunSpec, 'id' | 'title' | 'parentSessionId' | 'signal'>,
  parentSession: (sessionId: string) => { win?: BrowserWindow } | undefined
): Pick<ExtensionUIContext, 'select'> {
  const source = { kind: 'subagent' as const, id: spec.id, title: displayTitle(spec.title) }
  return {
    async select(title, choices, options) {
      const signals = [options?.signal, spec.signal].filter((signal): signal is AbortSignal => signal !== undefined)
      const signal = signals.length ? AbortSignal.any(signals) : undefined
      signal?.throwIfAborted()
      const parent = parentSession(spec.parentSessionId)
      const win = parent?.win
      if (!parent || !win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('The parent session is no longer open; the approval was refused')
      const check = () => {
        signal?.throwIfAborted()
        if (parentSession(spec.parentSessionId) !== parent || win.isDestroyed() || win.webContents.isDestroyed()) {
          throw new Error('The parent session is no longer open; the approval was refused')
        }
      }
      const ui = await createExtensionUI(win, spec.parentSessionId, 'subagent', source)
      check()
      const result = await ui.select(title, choices, { ...options, signal })
      check()
      return result
    }
  }
}
