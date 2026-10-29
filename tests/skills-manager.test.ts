/** Real SDK integration runs in an isolated home: browsing and preferences cannot mutate shared skills. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionCapability } from '../src/shared/session-capabilities'

async function fixture(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-skills-manager-')))
  process.env.HOME = join(root, 'home')
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
  const { mock } = await import('bun:test')
  const os = { ...await import('node:os') }
  mock.module('node:os', () => ({ ...os, homedir: () => join(root, 'home') }))
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const skill = async (dir: string, name: string, manual = false) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Work with ${name}\n${manual ? 'disable-model-invocation: true\n' : ''}---\nInstructions\n`)
  }
  try {
    const shared = join(root, 'home', '.agents', 'skills', 'shared-workflow')
    await skill(shared, 'shared-workflow')
    const piSkill = join(root, 'pi', 'skills', 'user-workflow')
    await skill(piSkill, 'user-workflow', true)
    const workspace = join(root, 'workspace')
    await skill(join(workspace, '.agents', 'skills', 'project-workflow'), 'project-workflow')
    const packageDir = join(root, 'unsafe-package')
    await mkdir(join(packageDir, 'extensions'), { recursive: true })
    const executed = join(root, 'executed')
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ pi: { extensions: ['./extensions/index.ts'] } }))
    await writeFile(join(packageDir, 'extensions', 'index.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(executed)}, 'bad'); export default () => {};`)
    await writeFile(join(root, 'pi', 'settings.json'), JSON.stringify({ packages: [packageDir] }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    const loadSkills = sdk.loadSkills
    const scans: string[][] = []
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      loadSkills: (options: Parameters<typeof loadSkills>[0]) => {
        scans.push(options?.skillPaths ?? [])
        return loadSkills(options)
      }
    }))
    const manager = await import('../src/main/skills/manager')
    const { createChatResourceLoader, createNoExtensionsResourceLoader, sessionSkillChoices } = await import('../src/main/pi/chat-resources')
    let inventory = await manager.listSkills()
    assert.deepEqual(inventory.skills.map((skill) => skill.name).sort(), ['shared-workflow', 'user-workflow'])
    assert.equal(inventory.skills.find((skill) => skill.name === 'user-workflow')?.manualOnly, true)
    assert.equal(existsSync(executed), false, 'opening settings must not resolve package extensions')
    const source = join(root, 'imports')
    await skill(join(source, 'shared-workflow'), 'shared-workflow')
    await skill(join(source, 'imported-workflow'), 'imported-workflow')
    await mkdir(join(source, 'imported-workflow', 'references'), { recursive: true })
    await writeFile(join(source, 'imported-workflow', 'references', 'guide.md'), 'source text')
    const probe = await manager.probeSkills(source)
    assert.equal(probe.candidates.find((item) => item.name === 'shared-workflow')?.installed, true)
    const result = await manager.installSkills(probe.token, [...probe.candidates.map((item) => item.path), '../../escape'])
    assert.deepEqual(result.installed, ['imported-workflow'])
    assert.equal(result.skipped.length, 2)
    await assert.rejects(manager.installSkills(probe.token, [probe.candidates[0].path]), /expired/)
    inventory = await manager.listSkills()
    const imported = inventory.skills.find((skill) => skill.managed)!
    assert.ok(imported)
    assert.equal(imported.kind, 'local')
    assert.equal(imported.icon, undefined, 'a local reference has no publisher avatar')
    assert.equal(imported.localReference, true)
    assert.equal(imported.filePath, join(source, 'imported-workflow', 'SKILL.md'))
    await writeFile(join(source, 'imported-workflow', 'SKILL.md'), (await manager.readSkill(imported.id)).replace('Instructions', 'Live instructions'))
    assert.match(await manager.readSkill(imported.id), /Live instructions/)
    assert.ok(inventory.skills.filter((skill) => !skill.managed).every((skill) => skill.icon === undefined))
    assert.match(await manager.readSkill(imported.id), /instructions/)
    assert.equal(await readFile(join(source, 'imported-workflow', 'references', 'guide.md'), 'utf8'), 'source text')

    let base: Parameters<typeof sessionSkillChoices>[0] = { skills: [], diagnostics: [] }
    const loader = await createNoExtensionsResourceLoader(workspace, [], { onSkillBase: (next) => { base = next } })
    // The full list is computed on demand from the SDK base the last reload saw.
    const choices = (): SessionCapability[] => sessionSkillChoices(base, false, {})
    assert.deepEqual(choices().find((skill) => skill.name === 'project-workflow')?.source, { kind: 'project' })
    assert.deepEqual(choices().find((skill) => skill.name === 'user-workflow')?.source, { kind: 'pi' })
    assert.deepEqual(choices().find((skill) => skill.name === 'shared-workflow')?.source, { kind: 'agents' })
    assert.deepEqual(choices().find((skill) => skill.name === 'imported-workflow')?.source, { kind: 'imported', name: imported.source })
    assert.equal(choices().find((skill) => skill.name === 'imported-workflow')?.description, 'Work with imported-workflow')
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === 'project-workflow'))
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === 'imported-workflow'))
    const chat = await createChatResourceLoader(workspace)
    assert.equal(chat.getSkills().skills.some((skill) => skill.name === 'project-workflow'), false)
    assert.ok(chat.getSkills().skills.some((skill) => skill.name === 'imported-workflow'))

    const sharedEntry = inventory.skills.find((skill) => skill.name === 'shared-workflow')!
    const before = await readFile(join(shared, 'SKILL.md'), 'utf8')
    await manager.setSkillEnabled(sharedEntry.id, false)
    await manager.setSkillEnabled(imported.id, false)
    scans.length = 0
    await loader.reload()
    assert.ok(scans.every((paths) => paths.every((path) => path !== join(source, 'imported-workflow') && !path.includes('.claude') && !path.includes('.codex'))), 'ordinary reload does not scan disabled copies or external roots')
    scans.length = 0
    assert.ok(choices().some((item) => item.id === imported.filePath), 'opening the capabilities list includes disabled copies')
    assert.ok(scans.some((paths) => paths.some((path) => path === join(source, 'imported-workflow'))), 'disabled copies are scanned on demand')
    assert.ok(scans.some((paths) => paths.some((path) => path.includes('.claude'))), 'foreign roots are scanned only for the full list')
    assert.equal(loader.getSkills().skills.some((skill) => ['shared-workflow', 'imported-workflow'].includes(skill.name)), false)
    assert.equal(await readFile(join(shared, 'SKILL.md'), 'utf8'), before)
    assert.equal((await manager.listSkills()).skills.find((skill) => skill.id === sharedEntry.id)?.enabled, false)
    const { saveSessionCapability } = await import('../src/main/pi/session-capabilities')
    saveSessionCapability('skill-session', 'skills', imported.filePath, true)
    saveSessionCapability('skill-session', 'skills', join(workspace, '.agents', 'skills', 'project-workflow', 'SKILL.md'), false)
    const scoped = await createNoExtensionsResourceLoader(workspace, [], { sessionId: 'skill-session' })
    assert.ok(scoped.getSkills().skills.some((skill) => skill.name === 'imported-workflow'), 'session can enable a globally disabled skill')
    assert.equal(scoped.getSkills().skills.some((skill) => skill.name === 'project-workflow'), false, 'project skills can be disabled per session')
    assert.equal(loader.getSkills().skills.some((skill) => skill.name === 'imported-workflow'), false, 'other loaders keep global preferences')
    saveSessionCapability('skill-session', 'skills', imported.filePath, null)
    await scoped.reload()
    assert.equal(scoped.getSkills().skills.some((skill) => skill.name === 'imported-workflow'), false, 'reset follows the global default')
    await assert.rejects(manager.removeSkill(sharedEntry.id), /Only skills imported/)
    await assert.rejects(manager.readSkill('../../secret'), /not found/)
    await manager.setSkillEnabled(imported.id, true)
    await loader.reload()
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === 'imported-workflow'), 'reload sees changed preferences without recreating the loader')

    await manager.removeSkill(imported.id)
    assert.equal(existsSync(imported.filePath), true, 'removing a reference never deletes source files')
    assert.equal(existsSync(join(source, 'imported-workflow', 'SKILL.md')), true)
    assert.equal(existsSync(join(root, 'pig', 'skill-backups')), false, 'references create no copies or backups')
    await loader.reload()
    assert.equal(loader.getSkills().skills.some((skill) => skill.name === 'imported-workflow'), false)

    const alias = join(root, 'pi', 'skills', 'shared-alias')
    await symlink(shared, alias)
    await loader.reload()
    assert.equal(loader.getSkills().skills.some((skill) => skill.name === 'shared-workflow'), false, 'exclusions follow a file identity, not one symlink spelling')

    // Preferences follow stable discovery links across application upgrades, not versioned targets.
    const versionOne = join(root, 'app', 'versions', 'one')
    const versionTwo = join(root, 'app', 'versions', 'two')
    for (const version of [versionOne, versionTwo]) {
      await skill(join(version, 'linked-default'), 'linked-default')
      await skill(join(version, 'linked-external'), 'linked-external')
    }
    const defaultLink = join(root, 'home', '.agents', 'skills', 'linked-default')
    const externalLink = join(root, 'home', '.claude', 'skills', 'linked-external')
    await mkdir(join(root, 'home', '.claude', 'skills'), { recursive: true })
    await symlink(join(versionOne, 'linked-default'), defaultLink)
    await symlink(join(versionOne, 'linked-external'), externalLink)
    const linkedEntries = (await manager.listSkills()).skills
    await manager.setSkillEnabled(linkedEntries.find((entry) => entry.name === 'linked-default')!.id, false)
    await manager.setSkillEnabled(linkedEntries.find((entry) => entry.name === 'linked-external')!.id, true)
    const preferences = JSON.parse(await readFile(join(root, 'pig', 'skills.json'), 'utf8'))
    assert.ok(preferences.disabledPaths.includes(join(defaultLink, 'SKILL.md')))
    assert.ok(preferences.enabledPaths.includes(join(externalLink, 'SKILL.md')))
    for (const [link, name] of [[defaultLink, 'linked-default'], [externalLink, 'linked-external']]) {
      await rm(link)
      await symlink(join(versionTwo, name), link)
    }
    await loader.reload()
    assert.equal(loader.getSkills().skills.some((entry) => entry.name === 'linked-default'), false)
    assert.equal(loader.getSkills().skills.some((entry) => entry.name === 'linked-external'), true)
    const upgradedEntries = (await manager.listSkills()).skills
    assert.equal(upgradedEntries.find((entry) => entry.name === 'linked-default')?.enabled, false)
    assert.equal(upgradedEntries.find((entry) => entry.name === 'linked-external')?.enabled, true)
    await manager.setSkillEnabled(upgradedEntries.find((entry) => entry.name === 'linked-default')!.id, true)
    await manager.setSkillEnabled(upgradedEntries.find((entry) => entry.name === 'linked-external')!.id, false)
    await loader.reload()
    assert.equal(loader.getSkills().skills.some((entry) => entry.name === 'linked-default'), true)
    assert.equal(loader.getSkills().skills.some((entry) => entry.name === 'linked-external'), false)
    await rm(defaultLink)
    await rm(externalLink)

    // Imports after loader construction must appear on its next reload too.
    const another = await manager.probeSkills(join(source, 'imported-workflow'))
    await manager.installSkills(another.token, another.candidates.map((item) => item.path))
    await loader.reload()
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === 'imported-workflow'))
    assert.equal(existsSync(executed), false)

    await skill(join(root, 'pi', 'skills', 'dupe-first'), 'duplicate-name')
    await skill(join(root, 'home', '.agents', 'skills', 'dupe-second'), 'duplicate-name')
    await skill(join(root, 'home', '.agents', 'skills', 'dupe-third'), 'duplicate-name')
    const duplicates = (await manager.listSkills()).skills.filter((skill) => skill.name === 'duplicate-name')
    assert.equal(duplicates.length, 3)
    for (const entry of duplicates.filter((skill) => !skill.filePath.includes('dupe-third'))) await manager.setSkillEnabled(entry.id, false)
    await loader.reload()
    assert.ok(loader.getSkills().skills.find((skill) => skill.name === 'duplicate-name')?.filePath.includes('dupe-third'), 'excluding earlier collisions reveals the next enabled candidate')

    // Claude Code and Codex directories are discovered but stay off until the user opts in.
    await skill(join(root, 'home', '.claude', 'skills', 'claude-workflow'), 'claude-workflow')
    await skill(join(root, 'home', '.codex', 'skills', 'codex-workflow'), 'codex-workflow')
    await skill(join(root, 'home', '.codex', 'skills', '.system', 'system-workflow'), 'system-workflow')
    await symlink(join(root, 'home', '.agents', 'skills', 'shared-workflow'), join(root, 'home', '.claude', 'skills', 'shared-link'))
    const foreign = (await manager.listSkills()).skills.filter((skill) => skill.agent)
    assert.deepEqual(foreign.map((skill) => [skill.name, skill.agent, skill.enabled]).sort(), [['claude-workflow', 'claude', false], ['codex-workflow', 'codex', false]], 'hidden system skills and links to already listed skills are not repeated')
    await loader.reload()
    assert.equal(loader.getSkills().skills.some((skill) => skill.name.endsWith('-workflow') && skill.name.startsWith('c')), false, 'off by default')
    assert.deepEqual(choices().find((skill) => skill.name === 'claude-workflow')?.source, { kind: 'claude' })
    assert.deepEqual(choices().find((skill) => skill.name === 'codex-workflow')?.source, { kind: 'codex' })
    const claude = foreign.find((skill) => skill.agent === 'claude')!
    const clash = join(root, 'clash')
    await skill(join(clash, 'claude-workflow'), 'claude-workflow')
    const clashProbe = await manager.probeSkills(clash)
    assert.equal(clashProbe.candidates[0].installed, false, 'a disabled foreign skill does not block installing that name')
    await manager.discardSkillProbe(clashProbe.token)
    await manager.setSkillEnabled(claude.id, true)
    await loader.reload()
    assert.ok(loader.getSkills().skills.some((skill) => skill.name === 'claude-workflow'))
    assert.equal(loader.getSkills().skills.some((skill) => skill.name === 'codex-workflow'), false)
    const chatAfter = await createChatResourceLoader(workspace)
    assert.ok(chatAfter.getSkills().skills.some((skill) => skill.name === 'claude-workflow'), 'an explicit opt-in also applies to Chat')
    assert.equal((await manager.listSkills()).skills.find((skill) => skill.id === claude.id)?.enabled, true)
    await manager.setSkillEnabled(claude.id, false)
    await loader.reload()
    assert.equal(loader.getSkills().skills.some((skill) => skill.name === 'claude-workflow'), false)

    // Importing a foreign directory references the same path, but its managed preference owns that path.
    const referenceProbe = await manager.probeSkills(join(root, 'home', '.claude', 'skills', 'claude-workflow'))
    await manager.installSkills(referenceProbe.token, referenceProbe.candidates.map((item) => item.path))
    const reference = (await manager.listSkills()).skills.find((item) => item.managed && item.name === 'claude-workflow')!
    const referenceChoices = () => choices().filter((item) => item.id === reference.filePath)
    assert.equal(manager.listSkillChoices(base, false).filter(({ skill }) => skill.filePath === reference.filePath).length, 1)
    assert.equal(referenceChoices().length, 1)
    assert.equal(referenceChoices()[0].enabled, true)
    assert.equal(referenceChoices()[0].source?.kind, 'imported')
    await loader.reload()
    assert.equal(loader.getSkills().skills.filter((item) => item.filePath === reference.filePath).length, 1)
    await chatAfter.reload()
    assert.equal(chatAfter.getSkills().skills.filter((item) => item.filePath === reference.filePath).length, 1)
    assert.equal(sessionSkillChoices(base, false, { [reference.filePath]: false }).find((item) => item.id === reference.filePath)?.enabled, false)
    assert.equal(manager.applySkillPreferences(base, false, { [reference.filePath]: false }).skills.some((item) => item.filePath === reference.filePath), false)
    await manager.setSkillEnabled(claude.id, true)
    await manager.setSkillEnabled(reference.id, false)
    await loader.reload()
    assert.equal(referenceChoices()[0].enabled, false)
    assert.equal(loader.getSkills().skills.some((item) => item.filePath === reference.filePath), false, 'foreign opt-in cannot bypass a disabled managed reference')
    assert.equal(sessionSkillChoices(base, false, { [reference.filePath]: true }).find((item) => item.id === reference.filePath)?.enabled, true)
    assert.equal(manager.applySkillPreferences(base, false, { [reference.filePath]: true }).skills.filter((item) => item.filePath === reference.filePath).length, 1)
    await manager.removeSkill(reference.id)
    await manager.setSkillEnabled(claude.id, false)

    // Remote revisions remain trackable, preserve stable paths, and refuse local edits or partial downloads.
    let remoteCommit = 'a'.repeat(40)
    let failDownload = false
    let removedUpstream = false
    let duringDownload: (() => Promise<void>) | undefined
    const remoteManifest = (commit: string) => `---\nname: remote-workflow\ndescription: Remote ${commit}\n---\nInstructions ${commit}\n`
    const fetcher: import('../src/main/skills/source').SkillFetcher = async (url) => {
      if (url.pathname.includes('/commits/')) return Response.json({ sha: remoteCommit })
      if (url.hostname === 'api.github.com') return Response.json({ tree: removedUpstream ? [] : [
        { path: 'skills/remote/SKILL.md', type: 'blob', mode: '100644', size: 200 },
        { path: 'skills/remote/guide.md', type: 'blob', mode: '100644', size: 50 }
      ] })
      if (url.pathname.endsWith('/guide.md')) await duringDownload?.()
      if (failDownload && url.pathname.endsWith('/guide.md')) return new Response('failed', { status: 503 })
      return new Response(url.pathname.endsWith('/SKILL.md') ? remoteManifest(url.pathname.split('/')[3]) : 'Guide ' + url.pathname.split('/')[3])
    }
    const remoteProbe = await manager.probeSkills('https://github.com/owner/repo/tree/main/skills', fetcher)
    assert.deepEqual((await manager.installSkills(remoteProbe.token, remoteProbe.candidates.map((item) => item.path), fetcher)).installed, ['remote-workflow'])
    const remote = (await manager.listSkills()).skills.find((item) => item.name === 'remote-workflow')!
    assert.deepEqual(remote.update, { commit: remoteCommit, ref: 'main', path: 'skills/remote/SKILL.md' })
    assert.equal((await manager.checkSkillUpdate(remote.id, fetcher)).available, false)
    remoteCommit = 'b'.repeat(40)
    assert.equal((await manager.checkSkillUpdate(remote.id, fetcher)).available, true)
    const oldText = await manager.readSkill(remote.id)
    failDownload = true
    await assert.rejects(manager.updateSkill(remote.id, fetcher), /503/)
    assert.equal(await manager.readSkill(remote.id), oldText)
    assert.equal((await manager.skillById(remote.id)).update?.commit, 'a'.repeat(40))
    failDownload = false
    let sessionBusy = false
    let idleChecks = 0
    const busyError = new Error('A task started before replacement')
    const assertIdle = () => { idleChecks++; if (sessionBusy) throw busyError }
    duringDownload = async () => { sessionBusy = true }
    await assert.rejects(manager.updateSkill(remote.id, fetcher, assertIdle), (error) => error === busyError)
    assert.equal(idleChecks, 1, 'idleness is checked after downloads, immediately before replacement')
    assert.equal(await manager.readSkill(remote.id), oldText)
    assert.equal((await manager.skillById(remote.id)).update?.commit, 'a'.repeat(40))
    assert.equal(existsSync(join(root, 'pig', 'skill-backups')) && (await readdir(join(root, 'pig', 'skill-backups'))).length > 0, false)
    duringDownload = undefined
    sessionBusy = false
    let releaseCheck!: () => void
    let checkStarted!: () => void
    const gate = new Promise<void>((resolve) => { releaseCheck = resolve })
    const started = new Promise<void>((resolve) => { checkStarted = resolve })
    const checking = manager.checkSkillUpdate(remote.id, async (url, init) => {
      if (url.pathname.includes('/commits/')) { checkStarted(); await gate }
      return fetcher(url, init)
    })
    await started
    const queuedUpdate = manager.updateSkill(remote.id, fetcher, assertIdle)
    sessionBusy = true
    releaseCheck()
    await checking
    await assert.rejects(queuedUpdate, (error) => error === busyError)
    assert.equal(idleChecks, 2, 'queued updates cannot rely on idleness at request time')
    assert.equal(await manager.readSkill(remote.id), oldText)
    sessionBusy = false
    await writeFile(remote.filePath, oldText + 'User edits')
    await assert.rejects(manager.updateSkill(remote.id, fetcher), /Local changes/)
    assert.match(await manager.readSkill(remote.id), /User edits/)
    await writeFile(remote.filePath, oldText)
    await manager.setSkillEnabled(remote.id, false)
    let observedAfterGuard: { content: string; commit: string } | undefined
    await manager.updateSkill(remote.id, fetcher, () => {
      assertIdle()
      queueMicrotask(() => {
        sessionBusy = true
        observedAfterGuard = {
          content: readFileSync(remote.filePath, 'utf8'),
          commit: JSON.parse(readFileSync(join(root, 'pig', 'skills.json'), 'utf8')).skills.find((item: { id: string }) => item.id === remote.id).remote.commit
        }
      })
    })
    assert.equal(observedAfterGuard?.commit, remoteCommit, 'task startup cannot interleave with the directory and registry commit')
    assert.match(observedAfterGuard!.content, new RegExp(remoteCommit))
    assert.equal((await manager.skillById(remote.id)).enabled, false)
    assert.equal((await manager.skillById(remote.id)).filePath, remote.filePath)
    assert.match(await manager.readSkill(remote.id), new RegExp(remoteCommit))
    assert.equal((await readdir(join(root, 'pig', 'skill-backups'))).length, 1)
    assert.equal((await manager.skillById(remote.id)).update?.commit, remoteCommit)
    remoteCommit = 'c'.repeat(40)
    const versionB = await manager.readSkill(remote.id)
    duringDownload = () => writeFile(remote.filePath, versionB + 'Concurrent edits')
    await assert.rejects(manager.updateSkill(remote.id, fetcher), /Local changes/)
    assert.match(await manager.readSkill(remote.id), /Concurrent edits/)
    await writeFile(remote.filePath, versionB)
    const storedRegistry = join(root, 'pig', 'skills.json')
    duringDownload = async () => {
      await rename(storedRegistry, storedRegistry + '.held')
      await mkdir(storedRegistry)
    }
    try { await assert.rejects(manager.updateSkill(remote.id, fetcher)) }
    finally {
      duringDownload = undefined
      await rm(storedRegistry, { recursive: true, force: true })
      await rename(storedRegistry + '.held', storedRegistry)
    }
    assert.equal(await manager.readSkill(remote.id), versionB, 'registry save failure rolls content back')
    assert.equal((await manager.skillById(remote.id)).update?.commit, 'b'.repeat(40))
    await assert.rejects(manager.updateSkill(imported.id, fetcher), /local reference|legacy snapshot/)
    removedUpstream = true
    await assert.rejects(manager.checkSkillUpdate(remote.id, fetcher), /removed or renamed/)
    assert.equal(await manager.readSkill(remote.id), versionB)
    // Older copies retain their contents and are not silently inferred to be references or updateable.
    const registryPath = join(root, 'pig', 'skills.json')
    const legacyState = JSON.parse(await readFile(registryPath, 'utf8'))
    const legacyId = '00000000-0000-4000-8000-000000000001'
    await skill(join(root, 'pig', 'skills', legacyId, 'legacy-workflow'), 'legacy-workflow')
    legacyState.skills.push({ id: legacyId, name: 'legacy-workflow', source, kind: 'local', enabled: true })
    await writeFile(registryPath, JSON.stringify(legacyState))
    const legacy = await manager.skillById(legacyId)
    assert.equal(legacy.localReference, undefined)
    assert.equal(legacy.update, undefined)
    await assert.rejects(manager.updateSkill(legacyId, fetcher), /legacy snapshot/)
    await manager.removeSkill(legacyId)
    assert.equal(existsSync(legacy.filePath), false)
    assert.equal(existsSync(source), true)

    // A Pig reference outranks an opted-in external skill of the same name, and the warning lands on the skipped one.
    await skill(join(root, 'twin-source', 'claude-twin'), 'claude-twin')
    await skill(join(root, 'home', '.claude', 'skills', 'claude-twin'), 'claude-twin')
    const twinProbe = await manager.probeSkills(join(root, 'twin-source'))
    await manager.installSkills(twinProbe.token, twinProbe.candidates.map((item) => item.path))
    const twins = (await manager.listSkills()).skills.filter((item) => item.name === 'claude-twin')
    const external = twins.find((item) => item.agent)!
    await manager.setSkillEnabled(external.id, true)
    const after = (await manager.listSkills()).skills.filter((item) => item.name === 'claude-twin')
    assert.deepEqual(after.find((item) => item.managed)!.diagnostics, [])
    assert.ok(after.find((item) => item.agent)!.diagnostics.join(' ').includes('loaded first: ' + join(root, 'twin-source')))
    await loader.reload()
    assert.equal(loader.getSkills().skills.find((item) => item.name === 'claude-twin')!.filePath, join(root, 'twin-source', 'claude-twin', 'SKILL.md'))
    assert.equal(existsSync(join(root, 'home', '.claude', 'skills', 'claude-workflow', 'SKILL.md')), true)
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (process.argv.includes('--fixture')) await fixture()
else test('skill ownership, collisions, preferences and project/Chat loading use the real SDK safely', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally { clearTimeout(timer); child.kill() }
}, 20_000)
