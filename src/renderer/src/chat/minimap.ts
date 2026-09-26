import type { Translate } from '../../../shared/i18n'
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
  const user = turn.bash
    ? [`!${turn.bash.command}`]
    : typeof content === 'string'
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

export function turnMinimapItem(turn: Turn, index: number, t: Translate, weight?: number): MinimapItem {
  const { content, user, answer } = turnText(turn)
  const text = user.find((value) => value.length > 0) ?? answer.find((value) => value.length > 0)
  const hasImages = typeof content !== 'string' && (content?.some((block) => block.type === 'image') ?? false)
  const id = renderKeyForTurn(turn, index)
  const head = t('minimap.turn', { n: index + 1 })
  const label = preview(text)
    ? `${head}${t('common.labelSeparator')}${preview(text)}`
    : turn.user
      ? `${head}${t('common.labelSeparator')}${t('turn.imageMessage')}`
      : `${head}${t('common.labelSeparator')}${t('minimap.conversation')}`
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

export function summaryMinimapItem(summary: TurnSummary, index: number, t: Translate): MinimapItem {
  return {
    id: summary.id,
    turnId: summary.id,
    label: summary.hasImages
      ? `${t('minimap.turn', { n: index + 1 })}${t('common.labelSeparator')}${t('turn.imageMessage')}`
      : t('minimap.turn', { n: index + 1 }),
    length: summary.bytes,
    hasImages: summary.hasImages,
    turn: index
  }
}
