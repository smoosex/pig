/** Jiti-loaded background process tools meet the main-process controller through this shared registry. */
export interface ProcessToolResult { text: string }

export interface ProcessStartOptions {
  cwd?: string
  name?: string
}

export interface ProcessWaitOptions {
  text?: string
  afterVersion?: number
  timeoutMs?: number
}

/** An exit the agent did not observe, for its session. */
export interface ProcessDelivery { text: string }

export interface ProcessAgentHost {
  start(sessionId: string, command: string, options: ProcessStartOptions, signal?: AbortSignal): Promise<ProcessToolResult>
  list(sessionId: string): Promise<ProcessToolResult>
  read(sessionId: string, processId: string, lines: number): Promise<ProcessToolResult>
  wait(sessionId: string, processId: string, options: ProcessWaitOptions, signal?: AbortSignal): Promise<ProcessToolResult>
  stop(sessionId: string, processId: string): Promise<ProcessToolResult>
  /** The extension instance of a live session registers how exit messages reach it. */
  attach(sessionId: string, deliver: (delivery: ProcessDelivery) => void): void
  detach(sessionId: string, deliver: (delivery: ProcessDelivery) => void): void
}

const key = Symbol.for('pig:process-agent-host')
type Slot = Record<symbol, ProcessAgentHost | undefined>

export function registerProcessAgentHost(host: ProcessAgentHost | undefined): void {
  (globalThis as Slot)[key] = host
}

export function processAgentHost(): ProcessAgentHost | undefined {
  return (globalThis as Slot)[key]
}
