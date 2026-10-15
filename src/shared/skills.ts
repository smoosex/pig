/** Skills remain files owned by main; only inventory and installation previews cross IPC. */
export type ExternalSkillAgent = 'claude' | 'codex'

export interface SkillInfo {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  kind: 'github' | 'local' | 'discovered'
  /** Set for skills found in another agent's directory; these start disabled and are read in place. */
  agent?: ExternalSkillAgent
  /** HTTPS avatar of the GitHub owner, shown through the `pig-mcp-icon` scheme; absent for local skills. */
  icon?: string
  managed: boolean
  enabled: boolean
  available: boolean
  manualOnly: boolean
  diagnostics: string[]
}

export interface SkillInventory {
  skills: SkillInfo[]
  diagnostics: { path: string; message: string }[]
}

export interface SkillCandidate {
  path: string
  name: string
  description: string
  manualOnly: boolean
  installed: boolean
  diagnostics: string[]
}

export interface SkillProbe {
  token: string
  source: string
  kind: 'github' | 'local'
  candidates: SkillCandidate[]
  diagnostics: { path: string; message: string }[]
}

export interface SkillInstallResult {
  installed: string[]
  skipped: { name: string; error: string }[]
}

export interface SkillMarketEntry {
  id: string
  name: string
  description: string
  repo: string
  skillId: string
  installs: number | null
  icon: string
  featured: boolean
}

export interface SkillMarketResult {
  skills: SkillMarketEntry[]
  error?: string
}

export interface SkillsApi {
  listSkills: () => Promise<SkillInventory>
  setSkillEnabled: (id: string, enabled: boolean) => Promise<void>
  removeSkill: (id: string) => Promise<void>
  readSkill: (id: string) => Promise<string>
  openSkillDirectory: (id: string) => Promise<void>
  probeSkills: (source: string) => Promise<SkillProbe>
  discardSkillProbe: (token: string) => Promise<void>
  installSkills: (token: string, paths: string[]) => Promise<SkillInstallResult>
  searchSkillMarket: (query: string) => Promise<SkillMarketResult>
  onSkillsChanged: (listener: () => void) => () => void
}
