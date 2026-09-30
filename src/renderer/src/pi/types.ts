import type { PastedTextDisplayMetadata } from '../../../shared/pasted-text'
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'

/**
 * Image content whose bytes are either inline (messages not written to a session file yet) or
 * served by the pig-image scheme (persisted turns, which must keep their payload small). At least
 * one of the two has to be named, so an image block always says where its bytes come from; turnImageSrc
 * resolves it, and callers skip the ones that resolve to nothing.
 */
export type PigImageContent = Omit<ImageContent, 'data'> &
  ({ data: string; url?: never } | { url: string; data?: never })

export interface PigUserMessage extends Omit<UserMessage, 'content'> {
  content: string | (TextContent | PigImageContent)[]
  pastedText?: PastedTextDisplayMetadata
}

export type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
}

export interface BashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  timestamp: number
  excludeFromContext?: boolean
}

export interface CustomMessage<T = unknown> {
  role: 'custom'
  customType: string
  content: string | (TextContent | ImageContent)[]
  display: boolean
  details?: T
  timestamp: number
}

export interface BranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId: string
  timestamp: number
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore: number
  timestamp: number
}

export type PiMessage =
  | PigUserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage

export type ToolPartialResult = Pick<ToolResultMessage, 'content' | 'details'>

export interface PiSessionEvent {
  type: string
  message?: PiMessage
  messages?: PiMessage[]
  name?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: ToolPartialResult
  result?: unknown
  isError?: boolean
  [key: string]: unknown
}

export function isPiMessage(value: unknown): value is PiMessage {
  if (!value || typeof value !== 'object') return false
  const role = (value as { role?: unknown }).role
  const timestamp = (value as { timestamp?: unknown }).timestamp
  return typeof role === 'string' && typeof timestamp === 'number'
}