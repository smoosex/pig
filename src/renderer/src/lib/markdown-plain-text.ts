/** Removes Markdown presentation while retaining text, code and block boundaries for clipboard copies. */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
type MarkdownNode = ReturnType<typeof parser.parse>['children'][number]

function nodeText(node: MarkdownNode): string {
  switch (node.type) {
    case 'definition':
    case 'thematicBreak':
      return ''
    case 'break':
      return '\n'
    case 'image':
    case 'imageReference':
      return node.alt ?? ''
    case 'footnoteReference':
      return `[${node.label ?? node.identifier}]`
    case 'tableRow':
      return node.children.map(nodeText).join('\t')
    case 'table':
    case 'list':
    case 'listItem':
      return node.children.map(nodeText).join('\n')
    case 'blockquote':
    case 'footnoteDefinition':
      return node.children.map(nodeText).join('\n\n')
    default:
      if ('value' in node) return node.value
      return node.children.map(nodeText).join('')
  }
}

export function markdownToPlainText(markdown: string): string {
  return parser.parse(markdown).children.map(nodeText).filter(Boolean).join('\n\n')
}
