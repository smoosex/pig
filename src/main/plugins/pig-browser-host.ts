/**
 * Bridge between the jiti-loaded pig-browser extension and Pig's browser controller in main.
 *
 * The extension only declares tools; pages, windows and session ownership live in main. Both module
 * instances meet on globalThis, like pig-subagent-host.
 */
import type { BrowserInteraction } from '../browser/agent-interaction'

export interface BrowserToolResult {
  text: string
  image?: { data: string; mimeType: string }
}

export type BrowserHistoryAction = 'back' | 'forward' | 'reload'
export interface BrowserWaitOptions {
  ref?: string
  selector?: string
  state?: 'visible' | 'hidden' | 'attached' | 'detached'
  timeout?: number
}

export interface BrowserAgentHost {
  tabs(sessionId: string): Promise<BrowserToolResult>
  open(sessionId: string, options: { browserId?: string; url?: string }, signal?: AbortSignal): Promise<BrowserToolResult>
  navigate(sessionId: string, url: string, signal?: AbortSignal): Promise<BrowserToolResult>
  history(sessionId: string, action: BrowserHistoryAction, signal?: AbortSignal): Promise<BrowserToolResult>
  snapshot(sessionId: string, signal?: AbortSignal): Promise<BrowserToolResult>
  screenshot(sessionId: string, signal?: AbortSignal): Promise<BrowserToolResult>
  console(sessionId: string, errorsOnly: boolean): Promise<BrowserToolResult>
  annotations(sessionId: string): Promise<BrowserToolResult>
  interact(sessionId: string, request: BrowserInteraction, signal?: AbortSignal): Promise<BrowserToolResult>
  wait(sessionId: string, options: BrowserWaitOptions, signal?: AbortSignal): Promise<BrowserToolResult>
}

const key = Symbol.for('pig:browser-agent-host')
type Slot = Record<symbol, BrowserAgentHost | undefined>

export function registerBrowserAgentHost(host: BrowserAgentHost | undefined): void {
  (globalThis as Slot)[key] = host
}

export function browserAgentHost(): BrowserAgentHost | undefined {
  return (globalThis as Slot)[key]
}
