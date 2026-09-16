import { renderKeyForTurn, type Turn } from './turns'
import type { TurnSummary } from '../ipc/api'

/**
 * One minimap row. Loaded turns describe themselves from the projected payload; turns the renderer
 * never loaded carry only their weight, so the bar keeps a scale without parsing the conversation.
 */
export interface MinimapItem {
  id: string
  turnId: string
  label: string
  length: number
  hasImages: boolean
  /** The turn's index in the whole branch: a window's rows are not the branch's first rows. */
  turn: number
}

export interface MinimapPreview {
  question: string
  answer: string
  hasQuestionImage: boolean
  hasAnswerImage: boolean
  streaming: boolean
  error: boolean
}

function preview(text: string | undefined): string {
  return text?.slice(0, 160).replace(/\s+/g, ' ').trim().slice(0, 60) ?? ''
}

function turnText(turn: Turn) {
  const content = turn.user?.content
  const user = typeof content === 'string'
    ? [content]
    : content?.flatMap((block) => block.type === 'text' ? [block.text] : []) ?? []
  const answer = turn.answer.flatMap((block) => block.type === 'text' ? [block.text] : [])
  return { content, user, answer }
}

export function turnMinimapPreview(turn: Turn): MinimapPreview {
  const { content, user, answer } = turnText(turn)
  return {
    question: user.join('\n').trim(),
    answer: answer.join('\n').trim(),
    hasQuestionImage: typeof content !== 'string' && (content?.some((block) => block.type === 'image') ?? false),
    hasAnswerImage: turn.answer.some((block) => block.type === 'image'),
    streaming: turn.streaming,
    error: Boolean(turn.errorMessage)
  }
}

export function turnMinimapItem(turn: Turn, index: number, weight?: number): MinimapItem {
  const { content, user, answer } = turnText(turn)
  const text = user.find((value) => value.length > 0) ?? answer.find((value) => value.length > 0)
  const hasImages = typeof content !== 'string' && (content?.some((block) => block.type === 'image') ?? false)
  const id = renderKeyForTurn(turn, index)
  const label = `第 ${index + 1} 轮${preview(text) ? `：${preview(text)}` : turn.user ? '：图片消息' : '对话'}`
  return {
    id,
    turnId: turn.id ?? id,
    label,
    hasImages,
    // A loaded turn is measured like the branch summary measures it, so the bar does not jump
    // between metric when the window pages in. Live turns have no summary row and use text length.
    length: weight ?? [...user, ...answer].reduce((sum, value) => sum + value.length, 0),
    turn: index
  }
}

export function summaryMinimapItem(summary: TurnSummary, index: number): MinimapItem {
  return {
    id: summary.id,
    turnId: summary.id,
    label: `第 ${index + 1} 轮${summary.hasImages ? '：图片消息' : ''}`,
    length: summary.bytes,
    hasImages: summary.hasImages,
    turn: index
  }
}
