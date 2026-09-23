/**
 * The `@` token behind the caret and the text a row completes to. Pi triggers on an `@` at a token
 * start and completes directories without a trailing space so the menu can descend; the composer
 * copies both, plus the `@"…"` quoting for paths with whitespace.
 */
export interface AtToken {
  /** Offset of the `@` within the block text before the caret. */
  start: number
  /** The token as typed, `@` included: `@src/ma`, `@`, or `@"my file`. */
  raw: string
  /** The path part: without the `@`, and without the opening quote when quoted. */
  query: string
  quoted: boolean
}

/**
 * Characters that end the token before an `@`: whitespace, quotes, the separators people put before
 * a mention in prose, and Pi's CJK punctuation — a CJK-script character that is also punctuation,
 * plus the fullwidth set. Anything else (notably `.` in `mail@example`) keeps the `@` literal.
 */
const TOKEN_DELIMITER =
  /[\s"'=,;:(\[{，．：；！？（）［］｛｝“”‘’…—]|(?=\p{Punctuation})[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u

export function atMentionToken(before: string): AtToken | null {
  // The quoted form exists so a path can hold spaces, which the scan below would cut at: an
  // unclosed `@"` at a token start is the token, whatever follows it.
  const openQuote = before.lastIndexOf('@"')
  if (
    openQuote !== -1 &&
    !before.slice(openQuote + 2).includes('"') &&
    (openQuote === 0 || TOKEN_DELIMITER.test(before[openQuote - 1]))
  ) {
    return { start: openQuote, raw: before.slice(openQuote), query: before.slice(openQuote + 2), quoted: true }
  }
  let start = before.length
  while (start > 0 && !TOKEN_DELIMITER.test(before[start - 1])) start -= 1
  const raw = before.slice(start)
  if (!raw.startsWith('@')) return null
  return { start, raw, query: raw.slice(1), quoted: false }
}

/** A row's completion text: quoted when the token was quoted or the path needs it to survive. */
export function mentionValue(path: string, quoted: boolean): string {
  return quoted || /\s/.test(path) ? `@"${path}"` : `@${path}`
}
