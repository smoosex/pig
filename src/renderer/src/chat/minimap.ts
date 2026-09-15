import { renderKeyForTurn, type Turn } from './turns'
import type { TurnSummary } from '../ipc/api'

/**
 * One minimap row. Loaded turns describe themselves from the projected payload; turns the renderer
 * never loaded carry only their weight, so the bar keeps a scale without parsing the conversation.
 */
export interface MinimapItem {
  id: string
  label: string
  length: number
  /** The turn's index in the whole branch: a window's rows are not the branch's first rows. */
  turn: number
}

function preview(text: string | undefined): string {
  return text?.slice(0, 160).replace(/\s+/g, ' ').trim().slice(0, 60) ?? ''
}

export function turnMinimapItem(turn: Turn, index: number): MinimapItem {
  const content = turn.user?.content
  const user = typeof content === 'string'
    ? [content]
    : content?.flatMap((block) => block.type === 'text' ? [block.text] : []) ?? []
  const answer = turn.answer.flatMap((block) => block.type === 'text' ? [block.text] : [])
  const text = user.find((value) => value.length > 0) ?? answer.find((value) => value.length > 0)
  const label = `第 ${index + 1} 轮${preview(text) ? `：${preview(text)}` : turn.user ? '：图片消息' : '对话'}`
  return {
    id: renderKeyForTurn(turn, index),
    label,
    length: [...user, ...answer].reduce((sum, value) => sum + value.length, 0),
    turn: index
  }
}

export function summaryMinimapItem(summary: TurnSummary, index: number): MinimapItem {
  return {
    id: summary.id,
    label: `第 ${index + 1} 轮${summary.hasImages ? '：图片消息' : ''}`,
    length: summary.bytes,
    turn: index
  }
}
