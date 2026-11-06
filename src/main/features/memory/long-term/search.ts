/** FTS terms include CJK bigrams so Chinese does not depend on whitespace tokenization. */
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
