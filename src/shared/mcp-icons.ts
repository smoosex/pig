/**
 * URL shape for MCP server icons.
 *
 * Catalog listings carry an HTTPS source; the renderer shows it through this scheme so main fetches
 * and caches the bytes under the shared address policy instead of the renderer contacting the host.
 */
export const MCP_ICON_SCHEME = 'pig-mcp-icon'

/** `pig-mcp-icon://icon/?u=<encoded source>` addresses one catalog icon source. */
export function mcpIconUrl(source: string): string {
  return `${MCP_ICON_SCHEME}://icon/?u=${encodeURIComponent(source)}`
}

export function parseMcpIconUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MCP_ICON_SCHEME}:` || parsed.hostname !== 'icon') return null
  return parsed.searchParams.get('u') || null
}
