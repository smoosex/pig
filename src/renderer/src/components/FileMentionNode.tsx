import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { fileMentionText } from '../../../shared/file-mentions'
import { FileMentionChip } from './FileMentionChip'

function FileMentionNodeView({ node, selected }: NodeViewProps) {
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="inline-flex align-middle"
    >
      <FileMentionChip path={String(node.attrs.path)} className={selected ? 'ring-2 ring-ring/50' : undefined} />
    </NodeViewWrapper>
  )
}

/** An `@` completion that landed on a file; its text form is the `@path` the model receives. */
export const FileMentionNode = Node.create({
  name: 'fileMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: '' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-file-mention]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-file-mention': '' })]
  },

  renderText({ node }) {
    return fileMentionText(String(node.attrs.path ?? ''))
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileMentionNodeView)
  }
})
