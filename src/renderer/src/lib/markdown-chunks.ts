/**
 * Splits long Markdown into independently renderable pieces so a huge document can be mounted a
 * piece at a time. Cuts prefer blank lines outside fenced code and list/quote containers. Memory
 * summaries write thousands of lines with no blank line between them, so once a piece reaches twice
 * the size it also ends at a plain line break, never before a line that could continue the block
 * (indented, a table row, or a setext underline). Constructs that reach across pieces, such as
 * reference-style link definitions, may lose their target.
 */
export function splitMarkdown(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const chunks: string[] = []
  const lines = text.split('\n')
  let fence: string | null = null
  let container = false
  let start = 0
  let length = 0
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index]
    length += line.length + 1
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (fence == null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length)) fence = null
    }
    if (fence != null) continue
    if (isContainerLine(line)) container = true
    const next = lines[index + 1]
    const blank = line.trim() === ''
    // A blank line can introduce another paragraph or nested block in the same list item.
    // Keep the whole container until an unindented non-container block follows a blank line.
    if (blank && canStartPiece(next) && !isContainerLine(next)) container = false
    if (container || length < size) continue
    if (blank && canStartPiece(next)) {
      chunks.push(lines.slice(start, index).join('\n'))
      start = index + 1
      length = 0
    } else if (length >= size * 2 && canStartPiece(lines[index + 1])) {
      chunks.push(lines.slice(start, index + 1).join('\n'))
      start = index + 1
      length = 0
    }
  }
  chunks.push(lines.slice(start).join('\n'))
  return chunks
}

function isContainerLine(line: string): boolean {
  return /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])\s)/.test(line)
}

function canStartPiece(line: string): boolean {
  return /^\S/.test(line) && !line.startsWith('|') && !/^(=+|-+)\s*$/.test(line)
}
