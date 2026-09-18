import type { ToolStep } from '../../chat/turns'

export function toolClusterLabel(steps: ToolStep[]): string {
  const n = steps.length
  switch (steps[0].name) {
    case 'read':
      return `读取 ${n} 个文件`
    case 'write':
      return `写入 ${n} 个文件`
    case 'edit':
      return `编辑 ${n} 个文件`
    case 'bash':
      return `执行 ${n} 个命令`
    case 'ls':
      return `列出 ${n} 次`
    case 'fffind':
    case 'find':
      return `查找 ${n} 次`
    case 'ffgrep':
    case 'grep':
      return `搜索 ${n} 次`
    default:
      return `调用 ${steps[0].name} ${n} 次`
  }
}

export function toolInput(step: ToolStep): string {
  const command = typeof step.args.command === 'string' ? step.args.command : undefined
  if (command) return `$ ${command}`
  const path = typeof step.args.path === 'string' ? step.args.path : undefined
  if (path) return path
  const pattern = typeof step.args.pattern === 'string' ? step.args.pattern : undefined
  if (pattern) return pattern
  return Object.keys(step.args).length > 0 ? JSON.stringify(step.args, null, 2) : ''
}

export function editList(args: Record<string, unknown>): { oldText: string; newText: string }[] {
  const edits = args.edits
  if (Array.isArray(edits)) {
    return edits.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as { oldText?: unknown; newText?: unknown }
      if (typeof row.oldText === 'string' && typeof row.newText === 'string') {
        return [{ oldText: row.oldText, newText: row.newText }]
      }
      return []
    })
  }
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    return [{ oldText: args.oldText, newText: args.newText }]
  }
  return []
}

export function splitReadOutput(text: string): { code: string; notice?: string } {
  const idx = text.lastIndexOf('\n\n[')
  if (idx === -1) return { code: text }
  const tail = text.slice(idx + 2)
  if (tail.startsWith('[') && tail.endsWith(']') && /offset=|exceeds /.test(tail)) {
    return { code: text.slice(0, idx), notice: tail }
  }
  return { code: text }
}
