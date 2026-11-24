import { Fragment, type ReactNode } from 'react'
import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { ListTodo } from 'lucide-react'
import type { KanbanStatus } from '../../../shared/kanban'
import { cn } from '../lib/utils'
import { useKanbanStore } from '../stores/kanban'
import { INLINE_CHIP_CLASS } from './inline-chip'
import { issueMentionLabel, issueMentionText, type IssueMention } from './composer/issue-mentions'
import { KanbanStatusIcon } from './kanban/kanban-icons'
import { Button } from './ui/button'

export function IssueMentionChip({
  number,
  fallbackTitle,
  fallbackStatus,
  selected = false,
  className
}: {
  number: number
  fallbackTitle?: string
  fallbackStatus?: KanbanStatus
  selected?: boolean
  className?: string
}) {
  const liveIssue = useKanbanStore((s) => s.items.find((item) => item.number === number))
  const title = liveIssue?.title ?? fallbackTitle ?? ''
  const status = liveIssue?.status ?? fallbackStatus
  const label = issueMentionLabel({ number, title })

  return (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      data-issue-mention={number}
      onClick={(event) => {
        event.stopPropagation()
        useKanbanStore.getState().openIssueDialog(number)
      }}
      className={cn(
        INLINE_CHIP_CLASS,
        'cursor-pointer',
        status === 'done' && 'opacity-75',
        selected && 'ring-2 ring-ring/50',
        className
      )}
      title={label}
    >
      {status ? (
        <KanbanStatusIcon status={status} className="size-3.5" />
      ) : (
        <ListTodo className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  )
}

/** Splits plain text on `@[issue:N]` markers so sent user bubbles render clickable issue chips. */
export function renderTextWithIssueChips(text: string): ReactNode {
  if (!text.includes('@[issue:')) return text
  const parts: ReactNode[] = []
  const pattern = /@\[issue:(\d+)\]/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push(<Fragment key={`t:${cursor}`}>{text.slice(cursor, match.index)}</Fragment>)
    }
    const num = Number(match[1])
    if (Number.isSafeInteger(num) && num >= 1) {
      parts.push(<IssueMentionChip key={`i:${match.index}:${num}`} number={num} />)
    } else {
      parts.push(<Fragment key={`r:${match.index}`}>{match[0]}</Fragment>)
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) {
    parts.push(<Fragment key={`t:${cursor}`}>{text.slice(cursor)}</Fragment>)
  }
  return parts
}

function IssueMentionView({ node, selected }: NodeViewProps) {
  const attrs = node.attrs as IssueMention
  return (
    <NodeViewWrapper as="span" contentEditable={false} className="inline-flex align-middle">
      <IssueMentionChip
        number={Number(attrs.number)}
        fallbackTitle={attrs.title}
        fallbackStatus={attrs.status}
        selected={selected}
      />
    </NodeViewWrapper>
  )
}

/** A Kanban issue chip in the Tiptap composer; serializes as `@[issue:number]`. */
export const IssueMentionNode = Node.create({
  name: 'issueMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      number: { default: 1 },
      title: { default: '' },
      status: { default: 'todo' },
      detail: { default: '' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-issue-mention-node]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-issue-mention-node': '' }),
      issueMentionText({ number: Number(node.attrs.number) })
    ]
  },

  renderText({ node }) {
    return issueMentionText({ number: Number(node.attrs.number) })
  },

  addNodeView() {
    return ReactNodeViewRenderer(IssueMentionView)
  }
})
