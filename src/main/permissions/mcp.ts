/**
 * MCP tool calls under the permission modes. Annotations are the server's own unverified claims, so
 * this stops Agent mistakes, not a malicious server; MCP server processes are not sandboxed.
 */
import type { ToolAnnotations } from '@earendil-works/pi-coding-agent'
import type { McpApproval, PermissionMode } from '../../shared/permissions'

/** Inline extension name of Pig's session tools (MCP, codemode, tool_search); MCP tools count only from it. */
export const SESSION_TOOLS_EXTENSION = 'pig-session-tools'
export const SESSION_TOOLS_PATH = `<inline:${SESSION_TOOLS_EXTENSION}>`

/** Codex's `auto` rule: destructive asks, read-only does not, anything not declared otherwise asks. */
export function mcpNeedsApproval(annotations: ToolAnnotations | undefined): boolean {
  if (annotations?.destructiveHint === true) return true
  if (annotations?.readOnlyHint === true) return false
  return annotations?.destructiveHint !== false || annotations?.openWorldHint !== false
}

export function mcpDecision(mode: PermissionMode, approval: McpApproval, annotations: ToolAnnotations | undefined): 'allow' | 'ask' | 'deny' {
  if (mode === 'full-access') return 'allow'
  if (mode === 'read-only') return approval !== 'prompt' && annotations?.readOnlyHint === true ? 'allow' : 'deny'
  if (approval === 'approve') return 'allow'
  return approval === 'prompt' || mcpNeedsApproval(annotations) ? 'ask' : 'allow'
}

/** Arguments as shown on the approval card; long values are cut so the card stays readable. */
export function mcpArguments(input: unknown): string {
  const text = JSON.stringify(input ?? {}, null, 2)
  return text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text
}
