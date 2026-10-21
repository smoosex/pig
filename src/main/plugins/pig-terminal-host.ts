/** Jiti-loaded terminal tools meet the main-process controller through this shared registry. */
export interface TerminalToolResult { text: string }

export interface TerminalAgentHost {
  tabs(sessionId: string): Promise<TerminalToolResult>
  open(sessionId: string, terminalId?: string, signal?: AbortSignal): Promise<TerminalToolResult>
  read(sessionId: string, lines: number, signal?: AbortSignal): Promise<TerminalToolResult>
  type(sessionId: string, text: string, submit: boolean, signal?: AbortSignal): Promise<TerminalToolResult>
  press(sessionId: string, key: string, signal?: AbortSignal): Promise<TerminalToolResult>
  release(sessionId: string): Promise<TerminalToolResult>
  sessionClosed(sessionId: string): void
}

const key = Symbol.for('pig:terminal-agent-host')
type Slot = Record<symbol, TerminalAgentHost | undefined>

export function registerTerminalAgentHost(host: TerminalAgentHost | undefined): void {
  (globalThis as Slot)[key] = host
}

export function terminalAgentHost(): TerminalAgentHost | undefined {
  return (globalThis as Slot)[key]
}
