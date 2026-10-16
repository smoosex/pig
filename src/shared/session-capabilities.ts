/** Session-local overrides inherit Pig's global defaults when a key is absent. */
export type CapabilityGroup = 'tools' | 'mcp' | 'skills'
export type SessionCapabilityOverrides = Record<CapabilityGroup, Record<string, boolean>>
export interface SessionSkillSource {
  kind: 'pi' | 'agents' | 'project' | 'claude' | 'codex' | 'imported'
  name?: string
}
/** Who provides a tool: Pi itself (built-ins and its bundled extensions) or a plugin. */
export interface SessionToolProvider {
  kind: 'pi' | 'plugin'
  name?: string
}
export interface SessionCapability {
  id: string
  name: string
  description?: string
  source?: SessionSkillSource
  provider?: SessionToolProvider
  enabled: boolean
  defaultEnabled: boolean
  overridden: boolean
}
export interface SessionCapabilities {
  tools: SessionCapability[]
  mcp: SessionCapability[]
  skills: SessionCapability[]
  busy: boolean
}
export interface SessionCapabilitiesApi {
  getSessionCapabilities(sessionId: string): Promise<SessionCapabilities>
  /** A null id applies to the entire group; null enabled removes session overrides. */
  setSessionCapability(sessionId: string, group: CapabilityGroup, id: string | null, enabled: boolean | null): Promise<SessionCapabilities>
}
