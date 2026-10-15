/** The UI uses real controls; out-of-order searches and abandoned import previews cannot take over. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, SkillInfo, SkillMarketResult, SkillProbe } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h, StrictMode } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const skills: SkillInfo[] = [
    { id: 'managed', name: 'managed-skill', description: 'A managed skill', filePath: '/pig/skills/managed/SKILL.md', source: 'https://github.com/owner/repo', kind: 'github', managed: true, enabled: true, available: true, manualOnly: false, diagnostics: [] },
    { id: 'external', name: 'external-skill', description: 'A discovered skill', filePath: '/home/.agents/skills/external/SKILL.md', source: '/home/.agents/skills/external', kind: 'discovered', managed: false, enabled: true, available: true, manualOnly: true, diagnostics: [] }
  ]
  const preferences: [string, boolean][] = []
  const discarded: string[] = []
  const installed: [string, string[]][] = []
  let finishOld: ((result: SkillMarketResult) => void) | undefined
  let finishProbe: ((result: SkillProbe) => void) | undefined
  let probeCount = 0
  const candidate = { path: 'some-skill/SKILL.md', name: 'some-skill', description: 'Some workflow', manualOnly: false, installed: false, diagnostics: [] }
  const preview = (token: string): SkillProbe => ({ token, source: 'owner/repo', kind: 'github', candidates: [candidate], diagnostics: [] })
  const service = {
    supportsGlass: false,
    listSkills: async () => ({ skills: skills.map((skill) => ({ ...skill })), diagnostics: [] }),
    onSkillsChanged: () => () => {},
    setSkillEnabled: async (id: string, enabled: boolean) => { preferences.push([id, enabled]); skills.find((skill) => skill.id === id)!.enabled = enabled },
    searchSkillMarket: async (query: string) => {
      if (query === 'old') return new Promise<SkillMarketResult>((resolve) => { finishOld = resolve })
      return { skills: query ? [{ id: 'new/result', name: 'new-result', repo: 'owner/repo', skillId: 'some-skill', description: 'Newest result', installs: 12, featured: false, icon: 'https://github.com/owner.png?size=96' }] : [] }
    },
    probeSkills: async (source: string) => {
      const token = `token-${++probeCount}`
      if (source === 'pending/repo') return new Promise<SkillProbe>((resolve) => { finishProbe = resolve })
      return preview(token)
    },
    discardSkillProbe: async (token: string) => { discarded.push(token) },
    installSkills: async (token: string, paths: string[]) => { installed.push([token, paths]); return { installed: ['some-skill'], skipped: [] } }
  } satisfies Partial<SessionApi>
  Object.assign(window, { api: service })
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en', localeSetting: 'en' })
  const { SkillsPane } = await import('../src/renderer/src/components/settings/SkillsPane')
  const { AddSkillDialog } = await import('../src/renderer/src/components/settings/AddSkillDialog')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) => {
    const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => (node.getAttribute('aria-label') ?? node.textContent) === label)
    assert.ok(node, `Missing button: ${label}`)
    return node
  }
  const click = async (label: string) => {
    await act(async () => {
      const node = button(label)
      node.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      node.click()
    })
  }
  const fill = async (label: string, value: string) => {
    const node = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    assert.ok(node)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const waitSearch = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 390)) })
  try {
    await act(async () => { root.render(h(SkillsPane)) })
    assert.ok(host.textContent?.includes('Managed by Pig'))
    assert.ok(host.textContent?.includes('Automatically discovered'))
    assert.ok(host.textContent?.includes('Manual invocation only'))
    await click('Enable external-skill')
    assert.deepEqual(preferences, [['external', false]])
    assert.equal(button('Enable external-skill').getAttribute('aria-checked'), 'false')

    await click('Discover')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    await fill('Search skills on skills.sh…', 'old')
    await waitSearch()
    assert.ok(finishOld)
    await fill('Search skills on skills.sh…', 'new')
    await waitSearch()
    assert.ok(host.textContent?.includes('new-result'))
    await act(async () => { finishOld!({ skills: [{ id: 'old/result', name: 'old-result', repo: 'owner/old', skillId: 'old', description: 'Old result', installs: 1, featured: false, icon: 'https://github.com/owner.png?size=96' }] }) })
    assert.ok(host.textContent?.includes('new-result'))
    assert.equal(host.textContent?.includes('old-result'), false)

    let closed = 0
    await act(async () => { root.render(h(StrictMode, null, h(AddSkillDialog, { initial: { source: 'owner/repo' }, onClose: () => { closed++ }, onInstalled: () => {} }))) })
    assert.ok(discarded.includes('token-1'), 'StrictMode discards its abandoned first preview')
    assert.ok(document.body.textContent?.includes('some-skill'))
    await click('Install 1 skills')
    assert.deepEqual(installed, [['token-2', ['some-skill/SKILL.md']]])
    assert.equal(closed, 1)

    await act(async () => { root.render(h(AddSkillDialog, { initial: { source: 'pending/repo' }, onClose: () => {}, onInstalled: () => {} })) })
    assert.ok(finishProbe)
    await act(async () => { root.render(null) })
    await act(async () => { finishProbe!(preview('abandoned')) })
    assert.ok(discarded.includes('abandoned'), 'a response arriving after close must release its source snapshot')
    assert.equal(installed.length, 1)
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}
if (process.argv.includes('--fixture')) await fixture()
else test('skills UI handles preferences, stale discovery searches and preview lifetime', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally { clearTimeout(timer); child.kill() }
}, 12_000)
