/** UI-only, topic-driven Dream. No history queue, time ranges or completion checkpoints. */
export type DreamRequest = { topic: string } | { repair: true }
export type DreamBudgetKind = 'tokens' | 'cost'
export interface DreamUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  cost: number | null
  requests: number
}
export const DREAM_TOKEN_LIMIT = 20_000_000
export const DREAM_COST_LIMIT = 20
export const dreamTokens = (usage: Pick<DreamUsage, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>): number =>
  usage.input + usage.cacheRead + usage.cacheWrite + usage.output
export interface DreamStatus {
  id?: string
  topic?: string
  repair?: boolean
  state: 'idle' | 'running' | 'done' | 'limited' | 'cancelled' | 'error'
  phase?: 'preparing' | 'searching' | 'reading' | 'maintaining' | 'wrappingUp' | 'publishing'
  wrappingUp?: DreamBudgetKind
  budgetStop?: { kind: DreamBudgetKind; used: number; limit: number }
  current?: string
  report?: string
  /** Run-relative transcript path; never a shared CLI session. */
  sessionFile?: string
  changes: string[]
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  cost: number
  costKnown: boolean
  requests: number
  error?: string
}
export interface DreamRecord extends DreamStatus {
  /** Older receipts did not separate cached tokens from input. */
  usageIncomplete?: boolean
  id: string
  startedAt: number
  endedAt: number
}
export type DreamRecordSummary = Pick<DreamRecord, 'id' | 'topic' | 'repair' | 'state' | 'startedAt' | 'endedAt'>
export interface DreamRecordPage {
  items: DreamRecordSummary[]
  nextOffset?: number
}
export interface DreamApi {
  list(offset?: number): Promise<DreamRecordPage>
  read(id: string): Promise<DreamRecord>
  start(request: DreamRequest): Promise<DreamStatus>
  status(): Promise<DreamStatus>
  stop(): Promise<DreamStatus>
}
