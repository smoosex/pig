/**
 * File references the composer inserts through `@` completion. The model receives the same `@path`
 * text Pi's own completion produces; the range and path travel beside the prompt, in the pasted-text
 * metadata, so the reference stays a chip in history and when the prompt returns to the composer.
 */
export interface FileMention {
  /** Worktree-relative and `/`-separated, as the completion listed it. */
  path: string
  start: number
  end: number
}

/** Paths with whitespace are quoted so the token survives Pi's own `@` scanning. */
export function fileMentionText(path: string, quoted = false): string {
  return quoted || /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export function isFileMentionShape(value: unknown): value is FileMention {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<FileMention>
  return typeof item.path === 'string' && item.path.length > 0 &&
    Number.isInteger(item.start) && item.start! >= 0 &&
    Number.isInteger(item.end) && item.end! > item.start!
}

/** A range holds exactly the text the composer wrote for its path, quoted or not. */
export function isFileMentionAt(content: string, mention: FileMention): boolean {
  const text = content.slice(mention.start, mention.end)
  return text === fileMentionText(mention.path) || text === fileMentionText(mention.path, true)
}

/** Ranges of both kinds must be ordered without overlap, since display interleaves them. */
export function rangesAreDisjoint(ranges: Array<{ start: number; end: number }>): boolean {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  return sorted.every((range, index) => index === 0 || sorted[index - 1].end <= range.start)
}
