/**
 * The `pig_servers` system prompt section lists Pig's built-in deferred tool servers the way Pi's
 * MCP extension lists deferred MCP servers in `mcp_servers`: rebuilt at every run start, so Pi
 * sends only a section patch when a server is switched on or off and the cached prefix stays intact.
 *
 * Each server's extension adds its own line. An unloaded extension writes nothing, and a server
 * whose tools the session switched off (exposure `hidden`) skips its line; with no lines the
 * section is absent and Pi removes it.
 */
import type { ExtensionAPI, ToolNamespace } from '@earendil-works/pi-coding-agent'

export const PIG_SERVERS_SECTION = 'pig_servers'
const INTRO = "Pig's built-in tool servers whose tools are not declared to you. Load their tools with `tool_search`."

export function listPigServer(pi: ExtensionAPI, namespace: ToolNamespace): void {
  pi.on('before_agent_start', (event) => {
    const available = pi.getAllTools().some((tool) => tool.namespace?.name === namespace.name && tool.exposure !== 'hidden')
    if (!available) return
    const { sections } = event.systemPromptOptions
    const lines = sections[PIG_SERVERS_SECTION]?.split('\n').slice(1) ?? []
    const head = `- ${namespace.name} (tool_search)`
    lines.push(namespace.description ? `${head}: ${namespace.description}` : head)
    // Sorted like mcp_servers, so extension load order cannot change the text.
    sections[PIG_SERVERS_SECTION] = [INTRO, ...lines.sort()].join('\n')
  })
}
