/**
 * The `pig-mcp-icon` scheme serves catalog icons through main's address policy and cache.
 *
 * The renderer only ever holds the opaque URL; the bytes come from `src/main/mcp/icons.ts`, so a
 * listing's icon source is never contacted by the renderer process.
 */
import { protocol } from 'electron'
import { MCP_ICON_SCHEME } from '../../shared/mcp-icons'
import { mcpIconResponse } from './icons'

/** Call before app ready; the privileges cannot be granted afterwards. */
export function registerMcpIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MCP_ICON_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export function handleMcpIcons(): void {
  protocol.handle(MCP_ICON_SCHEME, (request) => mcpIconResponse(request.url))
}
