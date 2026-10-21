/** Window-owned tab requests and live control state for the built-in terminal plugin. */
export interface TerminalAgentState {
  terminalId: string
  agentSessionId: string | null
}

/** Main asks the owning window to create, activate or remove a tab; the answer echoes the exact id. */
export type TerminalAgentOpenRequest = { requestId: string; sessionId: string } & (
  | { action?: 'open' }
  | { action: 'activate' | 'close'; terminalId: string }
)

export type TerminalAgentOpenAnswer = { terminalId: string } | { error: string }

export interface TerminalAgentApi {
  getAgentState(terminalId: string): Promise<TerminalAgentState>
  releaseAgent(terminalId: string, expectedSessionId: string): Promise<void>
  answerAgentOpen(requestId: string, result: TerminalAgentOpenAnswer): Promise<void>
  onAgentOpenRequest(listener: (request: TerminalAgentOpenRequest) => void): () => void
  onAgentState(listener: (state: TerminalAgentState) => void): () => void
}
