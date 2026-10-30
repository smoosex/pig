import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { Globe, MessageSquare, Terminal } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { INLINE_CHIP_CLASS } from './inline-chip'
import { tabMentionLabel, tabMentionText, type TabMention } from './composer/tab-mentions'

const ICONS = { browser: Globe, terminal: Terminal, session: MessageSquare } as const

function TabMentionView({ node, selected }: NodeViewProps) {
  const mention = node.attrs as TabMention
  const Icon = ICONS[mention.kind] ?? MessageSquare
  return (
    <NodeViewWrapper as="span" contentEditable={false} className="inline-flex align-middle">
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className={cn(INLINE_CHIP_CLASS, selected && 'ring-2 ring-ring/50')}
        title={[mention.title, mention.detail].filter(Boolean).join(' · ')}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{tabMentionLabel(mention)}</span>
      </Button>
    </NodeViewWrapper>
  )
}

/** An open browser, terminal or session; its text form `@[kind:id]` is what the model receives. */
export const TabMentionNode = Node.create({
  name: 'tabMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { kind: { default: 'session' }, id: { default: '' }, title: { default: '' }, detail: { default: '' } }
  },

  parseHTML() {
    return [{ tag: 'span[data-tab-mention]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-tab-mention': '' }), tabMentionText(node.attrs as TabMention)]
  },

  renderText({ node }) {
    return tabMentionText(node.attrs as TabMention)
  },

  addNodeView() {
    return ReactNodeViewRenderer(TabMentionView)
  }
})
