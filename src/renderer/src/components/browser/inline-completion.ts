/**
 * Chrome-style inline completion: the typed text is extended to the URL of the best history match it
 * prefixes, with the added part selected so typing on simply replaces it. Only pages the user has typed
 * before qualify; pages an agent or a link opened would otherwise surprise the address bar.
 */
import type { BrowserHistoryEntry } from '../../../../shared/browser'

export interface InlineCompletion {
  /** What the field shows: the typed text plus the completed remainder. */
  text: string
  /** Where Enter goes while the field still shows `text`; keeps the page's real scheme. */
  url: string
  entry: BrowserHistoryEntry
}

/** Without scheme and a leading www., and a bare root slash dropped so `github.com` completes as typed. */
function displayUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.host.replace(/^www\./i, '')
    const rest = url.slice(parsed.protocol.length + 2 + parsed.host.length)
    return host + (rest === '/' ? '' : rest)
  } catch {
    return null
  }
}

export function inlineCompletion(input: string, entries: BrowserHistoryEntry[]): InlineCompletion | null {
  if (/\s/.test(input)) return null
  const [prefix = ''] = input.match(/^(?:(https?):\/\/)?(?:www\.)?/i) ?? []
  const scheme = /^(https?):\/\//i.exec(input)?.[1]?.toLowerCase()
  const needle = input.slice(prefix.length).toLowerCase()
  if (!needle) return null
  for (const entry of entries) {
    if (entry.typedCount < 1 || (scheme && !entry.url.startsWith(`${scheme}://`))) continue
    const shown = displayUrl(entry.url)
    if (shown && shown.length > needle.length && shown.toLowerCase().startsWith(needle)) {
      return { text: input + shown.slice(needle.length), url: entry.url, entry }
    }
  }
  return null
}
