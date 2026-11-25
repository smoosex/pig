import { mergeAttributes, Node } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { skillMentionText } from '../../../shared/skill-mentions'
import { SkillMentionChip } from './SkillMentionChip'

function SkillMentionNodeView({ node, selected }: NodeViewProps) {
  const name = String(node.attrs.name ?? '')
  const description = node.attrs.description ? String(node.attrs.description) : undefined
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="inline-flex align-middle"
    >
      <SkillMentionChip
        name={name}
        description={description}
        className={selected ? 'ring-2 ring-ring/50' : undefined}
      />
    </NodeViewWrapper>
  )
}

export function hasSkillMention(doc: ProseMirrorNode): boolean {
  let found = false
  doc.descendants((node) => {
    if (node.type.name === 'skillMention') {
      found = true
      return false
    }
    return !found
  })
  return found
}

/** A `/skill:<name>` completion in the composer; its text form is `/skill:<name>` for Pi's expander. */
export const SkillMentionNode = Node.create({
  name: 'skillMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: { default: '' },
      description: { default: '' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-skill-mention-node]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-skill-mention-node': '' }),
      skillMentionText(String(node.attrs.name ?? ''))
    ]
  },

  renderText({ node }) {
    return skillMentionText(String(node.attrs.name ?? ''))
  },

  addNodeView() {
    return ReactNodeViewRenderer(SkillMentionNodeView)
  }
})
