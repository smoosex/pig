import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import type { PastedTextAttachment } from '../../../shared/pasted-text'
import { PastedTextChip } from './PastedTextChip'

function PastedTextNodeView({ node, selected }: NodeViewProps) {
  const attachment: PastedTextAttachment = {
    id: String(node.attrs.id),
    text: String(node.attrs.text),
    byteSize: Number(node.attrs.byteSize),
    ...(node.attrs.filename ? { filename: String(node.attrs.filename) } : {})
  }
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="inline-flex align-middle"
    >
      <PastedTextChip attachment={attachment} className={selected ? 'ring-2 ring-ring/50' : undefined} />
    </NodeViewWrapper>
  )
}

export const PastedTextNode = Node.create({
  name: 'pastedText',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null },
      text: { default: '' },
      byteSize: { default: 0 },
      filename: { default: null }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-pasted-text]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-pasted-text': '' })]
  },

  renderText({ node }) {
    return String(node.attrs.text ?? '')
  },

  addNodeView() {
    return ReactNodeViewRenderer(PastedTextNodeView)
  }
})
