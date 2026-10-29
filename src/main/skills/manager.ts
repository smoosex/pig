/**
 * Pig owns remote snapshots and preferences, never local references or skills discovered elsewhere. Pi's own personal
 * directories load by default and are switched off by exclusion; Claude Code and Codex directories are
 * not Pi sources, so their skills load only when the user opts in, straight from the original files.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  DefaultResourceLoader, SettingsManager, getAgentDir, loadSkills, loadSkillsFromDir,
  type LoadSkillsResult, type Skill
} from '@earendil-works/pi-coding-agent'
import type { ExternalSkillAgent, SkillInfo, SkillInstallResult, SkillInventory, SkillProbe, SkillUpdateCheck } from '../../shared/skills'
import type { SessionSkillSource } from '../../shared/session-capabilities'
import { pigPath } from '../pig-dir'
import { copyPreparedSkill, githubAvatar, githubSkillSource, prepareSkillSource, validSkillName, safeSkillPath, skillFingerprint, type PreparedSkills, type SkillFetcher } from './source'

interface ManagedSkill {
  id: string; name: string; source: string; kind: 'github' | 'local'; enabled: boolean
  localPath?: string
  remote?: { commit: string; ref: string; path: string; fingerprint: string }
}
interface SkillRegistry { skills: ManagedSkill[]; disabledPaths: string[]; enabledPaths: string[] }
const registryPath = () => pigPath('skills.json')
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const skillDirectory = (skill: ManagedSkill) => skill.localPath ?? pigPath('skills', skill.id, skill.name)
const probes = new Map<string, { prepared: PreparedSkills; at: number }>()
let writes: Promise<unknown> = Promise.resolve()
function change<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.catch(() => {}).then(operation)
  writes = next
  return next
}
function canonical(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}
function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
}
function registry(): SkillRegistry {
  let raw: SkillRegistry
  try { raw = JSON.parse(readFileSync(registryPath(), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { skills: [], disabledPaths: [], enabledPaths: [] }
    throw error
  }
  raw.enabledPaths ??= []
  if (!Array.isArray(raw.skills) || !Array.isArray(raw.disabledPaths) || raw.disabledPaths.some((path) => typeof path !== 'string') ||
    !Array.isArray(raw.enabledPaths) || raw.enabledPaths.some((path) => typeof path !== 'string') || raw.skills.some((skill) =>
    !skill || !uuid.test(skill.id) || !validSkillName(skill.name) || typeof skill.source !== 'string' || !['github', 'local'].includes(skill.kind) || typeof skill.enabled !== 'boolean'
  )) throw new Error('Invalid Pig skills registry')
  for (const skill of raw.skills) {
    if (skill.localPath !== undefined && (skill.kind !== 'local' || typeof skill.localPath !== 'string' || !isAbsolute(skill.localPath))) throw new Error('Invalid local skill reference')
    if (skill.remote !== undefined && (skill.kind !== 'github' || !skill.remote ||
      !/^[a-f0-9]{40}$/.test(skill.remote.commit) || !/^[a-f0-9]{64}$/.test(skill.remote.fingerprint) ||
      typeof skill.remote.ref !== 'string' || !skill.remote.ref || typeof skill.remote.path !== 'string' || !safeSkillPath(skill.remote.path))) throw new Error('Invalid remote skill tracking data')
  }
  return raw
}
async function save(value: SkillRegistry): Promise<void> {
  await mkdir(dirname(registryPath()), { recursive: true })
  const temporary = `${registryPath()}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, registryPath())
  } finally { await rm(temporary, { force: true }) }
}

/** Collisions have already been deduplicated by Pi. Recover losers before applying Pig's exclusions. */
function allSkills(base: LoadSkillsResult): Skill[] {
  const paths = base.diagnostics.flatMap((item) => item.type === 'collision' && item.collision?.resourceType === 'skill' ? [item.collision.loserPath] : [])
  if (!paths.length) return base.skills
  const extra = paths.flatMap((path) => loadSkills({ cwd: homedir(), agentDir: getAgentDir(), includeDefaults: false, skillPaths: [path] }).skills)
  return [...base.skills, ...extra]
}

/** Other agents' skill directories, which Pi does not read; hidden entries such as Codex's `.system` are skipped by the loader. */
function externalSkills(): { agent: ExternalSkillAgent; skills: Skill[]; diagnostics: LoadSkillsResult['diagnostics'] }[] {
  const roots: [ExternalSkillAgent, string][] = [
    ['claude', join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills')],
    ['codex', join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills')]
  ]
  return roots.map(([agent, dir]) => {
    const result = loadSkills({ cwd: homedir(), agentDir: getAgentDir(), includeDefaults: false, skillPaths: [dir] })
    return { agent, skills: result.skills.filter((skill) => basename(skill.filePath) === 'SKILL.md'), diagnostics: result.diagnostics }
  })
}

export interface SkillChoice { skill: Skill; defaultEnabled: boolean; source: SessionSkillSource }

/**
 * Every skill a session may load, with its global default. Disabled Pig copies and other agents'
 * directories are read only when `everything` is set: a build needs them only when a session
 * override turns one on, while the capability list shows them all.
 */
function skillChoices(base: LoadSkillsResult, chat: boolean, everything: boolean): { choices: SkillChoice[]; diagnostics: LoadSkillsResult['diagnostics'] } {
  const state = registry()
  const includeDisabled = everything
  const disabled = new Set(state.disabledPaths.map(canonical))
  const personal = (skill: Skill) => inside(skill.filePath, getAgentDir()) || inside(skill.filePath, join(homedir(), '.agents'))
  const candidates = allSkills(base).filter((skill) => !chat || personal(skill))
  const extra = loadSkills({
    cwd: homedir(), agentDir: getAgentDir(), includeDefaults: false,
    skillPaths: state.skills.filter((skill) => includeDisabled || skill.enabled).map(skillDirectory)
  })
  const optedIn = new Set(state.enabledPaths.map(canonical))
  const external = includeDisabled || optedIn.size
    ? externalSkills().flatMap(({ agent, skills }) => skills.map((skill) => ({ skill, agent }))) : []
  const managedDefaults = new Map(state.skills.map((entry) => [canonical(join(skillDirectory(entry), 'SKILL.md')), entry]))
  const choices: SkillChoice[] = [
    ...candidates.map((skill) => ({
      skill, defaultEnabled: !disabled.has(canonical(skill.filePath)),
      source: { kind: inside(skill.filePath, join(homedir(), '.agents')) ? 'agents' as const
        : personal(skill) ? 'pi' as const : 'project' as const }
    })),
    ...extra.skills.map((skill) => {
      const entry = managedDefaults.get(canonical(skill.filePath))
      return { skill, defaultEnabled: entry?.enabled === true, source: { kind: 'imported' as const, name: entry?.source } }
    }),
    // Managed references own their path even when disabled and omitted from the ordinary load.
    ...external.filter(({ skill }) => !managedDefaults.has(canonical(skill.filePath))).map(({ skill, agent }) => ({
      skill, defaultEnabled: optedIn.has(canonical(skill.filePath)), source: { kind: agent }
    }))
  ]
  const seen = new Set<string>()
  const unique = choices.filter(({ skill }) => {
    const path = canonical(skill.filePath)
    if (seen.has(path)) return false
    seen.add(path)
    return true
  })
  return { choices: unique, diagnostics: [...base.diagnostics.filter((item) => item.type !== 'collision'), ...extra.diagnostics] }
}

export function listSkillChoices(base: LoadSkillsResult, chat: boolean): SkillChoice[] {
  return skillChoices(base, chat, true).choices
}

export function applySkillPreferences(base: LoadSkillsResult, chat = false, overrides: Record<string, boolean> = {}): LoadSkillsResult {
  const { choices, diagnostics } = skillChoices(base, chat, Object.values(overrides).some(Boolean))
  const seen = new Set<string>()
  const names = new Map<string, Skill>()
  for (const { skill, defaultEnabled } of choices) {
    if (!(Object.hasOwn(overrides, skill.filePath) ? overrides[skill.filePath] : defaultEnabled)) continue
    const path = canonical(skill.filePath)
    if (seen.has(path)) continue
    seen.add(path)
    const winner = names.get(skill.name)
    if (winner) diagnostics.push({ type: 'collision', path: skill.filePath, message: `Skill “${skill.name}” is already provided by ${winner.filePath}` })
    else names.set(skill.name, skill)
  }
  return { skills: [...names.values()], diagnostics }
}

async function personalSkills(): Promise<LoadSkillsResult> {
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(await readFile(join(getAgentDir(), 'settings.json'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('Invalid Pi settings')
  // No package resolution, extension execution or project settings while browsing global settings.
  const loader = new DefaultResourceLoader({
    cwd: homedir(), agentDir: getAgentDir(),
    settingsManager: SettingsManager.inMemory({ ...settings, packages: [] }, { projectTrusted: false }),
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true
  })
  await loader.reload()
  const base = loader.getSkills()
  const personal = base.skills.filter((skill) => skill.sourceInfo.scope === 'user')
  const roots = [join(getAgentDir(), 'skills'), join(homedir(), '.agents', 'skills')]
  const losers = allSkills(base).filter((skill) => roots.some((root) => inside(skill.filePath, root)))
  const seen = new Set<string>()
  return {
    skills: [...personal, ...losers].filter((skill) => { const path = canonical(skill.filePath); if (seen.has(path)) return false; seen.add(path); return true }),
    diagnostics: base.diagnostics.filter((item) => !item.path || !inside(item.path, join(homedir(), '.pi', 'skills')))
  }
}

export async function listSkills(): Promise<SkillInventory> {
  await writes.catch(() => {})
  return inventory()
}
async function inventory(): Promise<SkillInventory> {
  const state = registry()
  const base = await personalSkills()
  const disabled = new Set(state.disabledPaths.map(canonical))
  const entries: SkillInfo[] = base.skills.map((skill) => ({
    id: `discovered:${skill.filePath}`, name: skill.name, description: skill.description,
    filePath: skill.filePath, source: dirname(skill.filePath), kind: 'discovered', managed: false,
    enabled: !disabled.has(canonical(skill.filePath)), available: true, manualOnly: skill.disableModelInvocation,
    diagnostics: base.diagnostics.filter((item) => item.path === skill.filePath && item.type !== 'collision').map((item) => item.message)
  }))
  const known = new Set(entries.map((entry) => canonical(entry.filePath)))
  const optedIn = new Set(state.enabledPaths.map(canonical))
  for (const { agent, skills, diagnostics } of externalSkills()) {
    for (const skill of skills) {
      const path = canonical(skill.filePath)
      // A directory that links into ~/.agents/skills shows the skill once, under Pi's own entry.
      if (known.has(path)) continue
      known.add(path)
      entries.push({
        id: `discovered:${skill.filePath}`, name: skill.name, description: skill.description,
        filePath: skill.filePath, source: dirname(skill.filePath), kind: 'discovered', agent, managed: false,
        enabled: optedIn.has(path), available: true, manualOnly: skill.disableModelInvocation,
        diagnostics: diagnostics.filter((item) => item.path === skill.filePath && item.type !== 'collision').map((item) => item.message)
      })
    }
  }
  for (const item of state.skills) {
    const result = loadSkillsFromDir({ dir: skillDirectory(item), source: 'path' })
    const skill = result.skills.find((skill) => basename(skill.filePath) === 'SKILL.md')
    entries.push({
      id: item.id, name: item.name, description: skill?.description ?? '', filePath: join(skillDirectory(item), 'SKILL.md'),
      source: item.source, kind: item.kind, managed: true, enabled: item.enabled,
      ...(item.localPath ? { localReference: true } : {}),
      ...(item.remote ? { update: { commit: item.remote.commit, ref: item.remote.ref, path: item.remote.path } } : {}),
      ...(item.kind === 'github' ? { icon: githubAvatar(item.source.replace('https://github.com/', '')) } : {}),
      available: !!skill && skill.name === item.name, manualOnly: skill?.disableModelInvocation ?? false,
      diagnostics: result.diagnostics.map((item) => item.message)
    })
  }
  // Same precedence as applySkillPreferences: Pi's own, Pig's copies, then other agents' directories.
  const names = new Map<string, SkillInfo>()
  const loadOrder = [...entries.filter((entry) => !entry.managed && !entry.agent), ...entries.filter((entry) => entry.managed), ...entries.filter((entry) => entry.agent)]
  for (const entry of loadOrder) {
    if (!entry.enabled || !entry.available) continue
    const winner = names.get(entry.name)
    if (winner) entry.diagnostics.push(`Another skill with this name is loaded first: ${winner.filePath}`)
    else names.set(entry.name, entry)
  }
  return { skills: entries, diagnostics: base.diagnostics.filter((item) => !base.skills.some((skill) => skill.filePath === item.path)).map((item) => ({ path: item.path ?? '', message: item.message })) }
}
export async function skillById(id: string): Promise<SkillInfo> {
  if (typeof id !== 'string') throw new Error('Skill id is required')
  const skill = (await listSkills()).skills.find((skill) => skill.id === id)
  if (!skill) throw new Error('Skill not found')
  return skill
}
export async function readSkill(id: string): Promise<string> {
  const skill = await skillById(id)
  return readFile(skill.filePath, 'utf8')
}
export function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  if (typeof id !== 'string' || typeof enabled !== 'boolean') return Promise.reject(new Error('Invalid skill preference'))
  return change(async () => {
    const state = registry()
    const managed = state.skills.find((skill) => skill.id === id)
    if (managed) managed.enabled = enabled
    else {
      const skill = (await inventory()).skills.find((skill) => skill.id === id && !skill.managed)
      if (!skill) throw new Error('Skill not found')
      // Persist the discovery path so versioned symlink targets can change without losing preferences.
      const path = resolve(skill.filePath)
      const target = canonical(path)
      const list = skill.agent ? 'enabledPaths' : 'disabledPaths'
      state[list] = state[list].filter((item) => canonical(item) !== target)
      if (enabled === !!skill.agent) state[list].push(path)
    }
    await save(state)
  })
}
export function removeSkill(id: string): Promise<void> {
  return change(async () => {
    const state = registry()
    const skill = state.skills.find((skill) => skill.id === id)
    if (!skill) throw new Error('Only skills imported by Pig can be removed here')
    const directory = pigPath('skills', skill.id)
    const backup = pigPath('skill-backups', `${Date.now()}-${skill.id}`)
    if (!skill.localPath && existsSync(directory)) { await mkdir(dirname(backup), { recursive: true }); await rename(directory, backup) }
    try { await save({ ...state, skills: state.skills.filter((item) => item.id !== id) }) }
    catch (error) { if (existsSync(backup)) await rename(backup, directory); throw error }
  })
}

function trackedSkill(state: SkillRegistry, id: string): ManagedSkill & { remote: NonNullable<ManagedSkill['remote']> } {
  const entry = state.skills.find((skill) => skill.id === id)
  if (!entry?.remote) throw new Error('This skill is a local reference or a legacy snapshot without update tracking; reinstall it to enable updates')
  return entry as ManagedSkill & { remote: NonNullable<ManagedSkill['remote']> }
}

function revisionSkill(prepared: PreparedSkills, entry: ManagedSkill & { remote: NonNullable<ManagedSkill['remote']> }): Skill {
  const skill = prepared.skills.find((skill) => relative(prepared.root, skill.filePath).split(sep).join('/') === entry.remote.path)
  if (!skill || skill.name !== entry.name) throw new Error('The upstream skill was removed or renamed; the installed version was left unchanged')
  return skill
}

export function checkSkillUpdate(id: string, fetcher?: SkillFetcher): Promise<SkillUpdateCheck> {
  return change(async () => {
    const entry = trackedSkill(registry(), id)
    const prepared = await prepareSkillSource(entry.source, fetcher)
    try {
      revisionSkill(prepared, entry)
      return { available: prepared.commit !== entry.remote.commit, currentCommit: entry.remote.commit, latestCommit: prepared.commit! }
    } finally { await prepared.cleanup() }
  })
}

/** Stage first, then swap synchronously at the stable path so session-specific preferences survive updates. */
export function updateSkill(id: string, fetcher?: SkillFetcher, assertIdle: () => void = () => {}): Promise<void> {
  return change(async () => {
    const state = registry()
    const entry = trackedSkill(state, id)
    const directory = pigPath('skills', entry.id)
    const stage = pigPath('skills', `${entry.id}.stage-${randomUUID()}`)
    const registryStage = `${registryPath()}.${randomUUID()}.tmp`
    const backup = pigPath('skill-backups', `${Date.now()}-${entry.id}-${randomUUID()}`)
    const assertUnmodified = async () => {
      if (await skillFingerprint(skillDirectory(entry)) !== entry.remote.fingerprint) throw new Error('Local changes detected; update refused to avoid overwriting your edits')
    }
    await assertUnmodified()
    const prepared = await prepareSkillSource(entry.source, fetcher)
    try {
      const skill = revisionSkill(prepared, entry)
      if (prepared.commit === entry.remote.commit) return
      await copyPreparedSkill(prepared, skill, join(stage, entry.name), fetcher)
      const fingerprint = await skillFingerprint(join(stage, entry.name))
      await mkdir(dirname(backup), { recursive: true })
      const next = { ...state, skills: state.skills.map((item) => item === entry
        ? { ...entry, remote: { ...entry.remote, commit: prepared.commit!, fingerprint } } : item) }
      await writeFile(registryStage, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      await assertUnmodified()
      // The synchronous guard, directory swap and registry commit cannot interleave with task startup.
      assertIdle()
      renameSync(directory, backup)
      try { renameSync(stage, directory) }
      // A failed directory swap restores the old files before propagating the original IO error.
      catch (error) { renameSync(backup, directory); throw error }
      try { renameSync(registryStage, registryPath()) }
      // A failed registry commit rolls the directory back synchronously, before tasks can start.
      catch (error) {
        renameSync(directory, stage)
        renameSync(backup, directory)
        throw error
      }
    } finally {
      await prepared.cleanup()
      await rm(stage, { recursive: true, force: true })
      await rm(registryStage, { force: true })
    }
  })
}

export async function discardSkillProbe(token: string): Promise<void> {
  const probe = probes.get(token)
  if (probe) { probes.delete(token); await probe.prepared.cleanup() }
}
export async function probeSkills(source: string, fetcher?: SkillFetcher): Promise<SkillProbe> {
  for (const [token, probe] of probes) if (Date.now() - probe.at > 15 * 60_000 || probes.size >= 8) await discardSkillProbe(token)
  const prepared = await prepareSkillSource(source, fetcher)
  const token = randomUUID()
  try {
    // Another agent's skill that is off does not occupy the name; enabling it later shows a collision.
    const existing = (await listSkills()).skills.filter((skill) => !skill.agent)
    const candidates = prepared.skills.filter((skill) => validSkillName(skill.name)).map((skill) => ({
      path: relative(prepared.root, skill.filePath).split(sep).join('/'), name: skill.name, description: skill.description,
      manualOnly: skill.disableModelInvocation, installed: existing.some((item) => item.name === skill.name),
      diagnostics: prepared.diagnostics.filter((item) => item.path === skill.filePath).map((item) => item.message)
    }))
    probes.set(token, { prepared, at: Date.now() })
    return { token, source: prepared.source, kind: prepared.kind, candidates, diagnostics: prepared.diagnostics.map((item) => ({ path: relative(prepared.root, item.path ?? prepared.root), message: item.message })) }
  } catch (error) { await prepared.cleanup(); throw error }
}

export function installSkills(token: string, paths: string[], fetcher?: SkillFetcher): Promise<SkillInstallResult> {
  return change(async () => {
    const probe = probes.get(token)
    if (!probe || Date.now() - probe.at > 15 * 60_000) throw new Error('This preview expired; scan the source again')
    if (!Array.isArray(paths) || !paths.length || paths.length > 200 || paths.some((path) => typeof path !== 'string')) throw new Error('Select at least one skill')
    // Consume the token before IO. Another window cannot install or discard an in-flight preview.
    probes.delete(token)
    const result: SkillInstallResult = { installed: [], skipped: [] }
    try {
      const state = registry()
      const names = new Set((await inventory()).skills.filter((skill) => !skill.agent).map((skill) => skill.name))
      for (const path of new Set(paths)) {
        const skill = probe.prepared.skills.find((skill) => relative(probe.prepared.root, skill.filePath).split(sep).join('/') === path)
        if (!skill || !validSkillName(skill.name)) { result.skipped.push({ name: path, error: 'Skill was not in the preview' }); continue }
        if (names.has(skill.name)) { result.skipped.push({ name: skill.name, error: 'A skill with this name already exists; it was left unchanged' }); continue }
        const entry: ManagedSkill = { id: randomUUID(), name: skill.name, source: probe.prepared.source, kind: probe.prepared.kind, enabled: true }
        const directory = skillDirectory(entry)
        try {
          if (entry.kind === 'local') {
            const current = loadSkillsFromDir({ dir: skill.baseDir, source: 'path' }).skills.find((item) => item.filePath === skill.filePath)
            if (!current || current.name !== entry.name) throw new Error('Skill changed since the preview; scan the source again')
            entry.localPath = skill.baseDir
          } else {
            await copyPreparedSkill(probe.prepared, skill, directory, fetcher)
            entry.remote = {
              commit: probe.prepared.commit!, ref: githubSkillSource(entry.source).ref,
              path: relative(probe.prepared.root, skill.filePath).split(sep).join('/'),
              fingerprint: await skillFingerprint(directory)
            }
          }
          state.skills.push(entry)
          try { await save(state) } catch (error) { state.skills.pop(); throw error }
          names.add(skill.name)
          result.installed.push(skill.name)
        } catch (error) {
          await rm(pigPath('skills', entry.id), { recursive: true, force: true })
          result.skipped.push({ name: skill.name, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return result
    } finally { await probe.prepared.cleanup() }
  })
}
