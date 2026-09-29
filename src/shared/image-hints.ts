/** Remove SDK image metadata from display copies without changing the stored user message. */
const DIMENSION_PREFIX = '[Image: original '
const DIMENSION_SUFFIX = ' to map to original image.]'
const CONVERSION_PREFIX = '[Image converted from '
const CONVERSION_SUFFIX = '.]'
const OMITTED_HINTS = new Set([
  '[Image omitted: could not be converted to a supported inline image format.]',
  '[Image omitted: could not be resized below the inline image size limit.]'
])

function isImageHint(line: string): boolean {
  return (
    (line.startsWith(DIMENSION_PREFIX) &&
      line.includes(', displayed at ') &&
      line.includes('. Multiply coordinates by ') &&
      line.endsWith(DIMENSION_SUFFIX)) ||
    (line.startsWith(CONVERSION_PREFIX) && line.includes(' to ') && line.endsWith(CONVERSION_SUFFIX)) ||
    OMITTED_HINTS.has(line)
  )
}

function stripImageHints(text: string): string {
  if (!text.endsWith(']')) return text
  const lines = text.split('\n')
  let start = lines.length
  while (start > 0 && isImageHint(lines[start - 1])) start--
  if (start === lines.length || start === 0 || lines[start - 1] !== '') return text
  const kept = lines.slice(start).filter((line) => OMITTED_HINTS.has(line))
  if (kept.length === lines.length - start) return text
  const body = lines.slice(0, start - 1).join('\n')
  return kept.length > 0 ? `${body}\n\n${kept.join('\n')}` : body
}

export function stripImageHintsFromContent<T>(content: T): T {
  if (!Array.isArray(content) || !content.some((block) => block?.type === 'image')) return content
  const index = content.findLastIndex((block) => block?.type === 'text' && typeof block.text === 'string')
  if (index < 0) return content
  const text = stripImageHints(content[index].text)
  if (text === content[index].text) return content
  return content.map((block, position) => position === index ? { ...block, text } : block) as T
}
