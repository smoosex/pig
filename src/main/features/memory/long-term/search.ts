/** FTS terms and locale-independent query hints; not translated UI copy or authorization rules. */
export const MEMORY_QUERY_PATTERNS = {
  preference: /偏好|习惯|平时|prefer|usual/i,
  lesson: /报错|错误|失败|排查|教训|error|exception|debug|failure/i,
  directory: /做过.*项目|哪些项目|项目经历|projects|worked on/i,
}
export function memoryTerms(text: string): string[] {
  const terms = new Set<string>()
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_]+/gu)) {
    const word = match[0]
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)) {
      const chars = [...word]
      for (let i = 0; i < chars.length; i++) {
        terms.add(chars[i]!)
        if (i + 1 < chars.length) terms.add(chars[i]! + chars[i + 1]!)
      }
    } else terms.add(word)
  }
  return [...terms]
}

export function memoryQuery(query: string): string | undefined {
  const terms = memoryTerms(query).filter(term => [...term].length > 1).slice(0, 32)
  return terms.length ? terms.map(term => `"${term}"`).join(' OR ') : undefined
}
