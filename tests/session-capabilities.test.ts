/** Session controls send scoped mutations and never call the global settings APIs. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, SessionCapabilities } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const mutations: unknown[] = []
  const state: SessionCapabilities = {
    tools: [
      { id: 'read', name: 'read', description: 'Read files and images', provider: { kind: 'pi' }, enabled: true, defaultEnabled: true, overridden: false },
      { id: 'web_search', name: 'web_search', provider: { kind: 'plugin', name: 'web-access' }, enabled: true, defaultEnabled: true, overridden: false },
      { id: 'mystery', name: 'mystery', provider: { kind: 'plugin' }, enabled: true, defaultEnabled: true, overridden: false }
    ],
    mcp: [{ id: 'server', name: 'server', description: 'Search remote documentation', enabled: false, defaultEnabled: false, overridden: false }],
    skills: [
      { id: '/workflow/SKILL.md', name: 'workflow', description: 'Follow the project workflow', source: { kind: 'project' }, enabled: true, defaultEnabled: true, overridden: false },
      { id: '/claude/SKILL.md', name: 'claude-workflow', source: { kind: 'claude' }, enabled: false, defaultEnabled: false, overridden: false },
      { id: '/imported/SKILL.md', name: 'imported-workflow', source: { kind: 'imported', name: 'https://github.com/owner/repo' }, enabled: true, defaultEnabled: true, overridden: false }
    ],
    busy: false
  }
  const service = {
    getSessionCapabilities: async (sessionId: string) => { assert.equal(sessionId, 'session-a'); return structuredClone(state) },
    setSessionCapability: async (sessionId, group, id, enabled) => {
      mutations.push([sessionId, group, id, enabled])
      for (const item of state[group].filter((item) => id === null || item.id === id)) {
        item.enabled = enabled ?? item.defaultEnabled
        item.overridden = enabled !== null
      }
      return structuredClone(state)
    },
    onMcpChanged: () => () => {}, onSkillsChanged: () => () => {}
  } satisfies Partial<SessionApi>
  Object.assign(window, { api: service })
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en', localeSetting: 'en' })
  const { SessionCapabilitiesButton } = await import('../src/renderer/src/components/composer/SessionCapabilitiesButton')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const view = (sessionId: string | null, busy: boolean) => h(TooltipProvider, null, h(SessionCapabilitiesButton, { sessionId, busy }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const click = async (selector: string) => {
    const node = document.querySelector<HTMLButtonElement>(selector)
    assert.ok(node, selector)
    await act(async () => {
      node.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      node.click()
    })
  }
  try {
    await act(async () => { root.render(view('session-a', false)) })
    await click('button[aria-label="Session capabilities"]')
    await act(async () => { await Bun.sleep(0) })
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    assert.equal(document.activeElement, content, 'opening focuses the panel, not a bulk action or its tooltip')
    assert.equal(content.tabIndex, -1, 'the panel does not add a Tab stop')
    assert.equal(document.querySelector('[role="tooltip"]'), null)
    const activePanel = () => document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')!
    assert.ok(activePanel().textContent?.includes('read'))
    const description = () => activePanel().querySelector<HTMLElement>('[data-slot="field-description"]')!
    assert.equal(description().textContent, 'Read files and images')
    assert.ok(description().classList.contains('line-clamp-2'))
    const label = activePanel().querySelector<HTMLElement>('[data-slot="field-label"]')!
    for (const node of [label, description()]) {
      assert.ok(node.classList.contains('text-xs'))
      assert.ok(node.classList.contains('font-normal'))
    }
    assert.deepEqual([...activePanel().querySelectorAll('[data-slot="badge"]')].map((node) => node.textContent), ['built-in', 'web-access', 'plugin'])
    assert.equal(activePanel().querySelector('[role="switch"]')?.getAttribute('aria-describedby'), description().id)
    assert.equal(document.body.textContent?.includes('workflow'), false)
    assert.ok(activePanel().classList.contains('overflow-x-hidden'))
    assert.ok(activePanel().classList.contains('[scrollbar-width:none]'))
    assert.ok(activePanel().classList.contains('[&::-webkit-scrollbar]:hidden'))
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    assert.deepEqual(tabs.map((tab) => tab.textContent), ['Tools', 'MCP', 'Skills'])
    assert.equal(activePanel().parentElement?.lastElementChild?.getAttribute('role'), 'tablist', 'tabs stay below the content')
    await click('button[role="switch"]')
    assert.deepEqual(mutations, [['session-a', 'tools', 'read', false]])
    await click('button[aria-label="read: Use global default"]')
    assert.deepEqual(mutations[1], ['session-a', 'tools', 'read', null])
    await click(`button[role="tab"][id="${tabs[1].id}"]`)
    assert.ok(activePanel().textContent?.includes('server'))
    assert.equal(description().textContent, 'Search remote documentation')
    assert.ok(description().classList.contains('line-clamp-2'))
    assert.equal(document.body.textContent?.includes('workflow'), false)
    await click('button[role="switch"]')
    assert.deepEqual(mutations[2], ['session-a', 'mcp', 'server', true])
    await click(`button[role="tab"][id="${tabs[2].id}"]`)
    assert.ok(activePanel().textContent?.includes('workflow'))
    assert.equal(activePanel().textContent?.includes('server'), false)
    assert.equal(description().textContent, 'Follow the project workflow')
    assert.ok(description().classList.contains('line-clamp-2'))
    const sources = [...activePanel().querySelectorAll<HTMLButtonElement>('[data-slot="collapsible-trigger"]')]
    assert.deepEqual(sources.map((node) => node.textContent), ['Project skills1', 'Claude Code1', 'owner/repo1'])
    assert.ok(sources.every((node) => node.classList.contains('text-xs') && node.classList.contains('font-normal')))
    assert.ok(sources[0].querySelector('[title="Project skills"]')?.parentElement?.classList.contains('h-full'), 'source titles fill the header height')
    assert.ok(sources[0].classList.contains('px-1') && sources[0].classList.contains('border-0'))
    assert.ok(activePanel().querySelector('[data-slot="collapsible-content"] > [data-slot="field-group"]')?.classList.contains('pl-2.25'), 'rows start under the chevron glyph')
    const projectSelector = 'button[data-slot="collapsible-trigger"]'
    await click(projectSelector)
    assert.equal(sources[0].getAttribute('aria-expanded'), 'false')
    assert.equal(activePanel().textContent?.includes('Follow the project workflow'), false)
    assert.ok(activePanel().textContent?.includes('claude-workflow'), 'collapsing one source does not collapse others')
    await click(projectSelector)
    assert.equal(sources[0].getAttribute('aria-expanded'), 'true')
    assert.ok(activePanel().textContent?.includes('Follow the project workflow'))
    assert.ok(activePanel().textContent?.includes('No description available'))
    await click(projectSelector)
    const bulkButton = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    for (const label of ['Enable all', 'Disable all', 'Use global default']) assert.equal(bulkButton(label).textContent, '', 'bulk actions are icon-only')
    await click('button[aria-label="Disable all"]')
    assert.deepEqual(mutations.at(-1), ['session-a', 'skills', null, false])
    assert.ok(state.skills.every((item) => !item.enabled && item.overridden), 'bulk changes include collapsed sources')
    assert.equal(state.tools[0].enabled, true, 'other tabs remain unchanged')
    assert.equal(state.mcp[0].enabled, true)
    await click('button[aria-label="Enable all"]')
    assert.deepEqual(mutations.at(-1), ['session-a', 'skills', null, true])
    assert.ok(state.skills.every((item) => item.enabled && item.overridden))
    await click('button[aria-label="Use global default"]')
    assert.deepEqual(mutations.at(-1), ['session-a', 'skills', null, null])
    assert.ok(state.skills.every((item) => item.enabled === item.defaultEnabled && !item.overridden))
    await act(async () => { root.render(view('session-a', true)) })
    assert.ok([...document.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].every((node) => node.disabled))
    for (const label of ['Enable all', 'Disable all', 'Use global default']) assert.equal(bulkButton(label).disabled, true)
    await act(async () => { root.render(view(null, false)) })
    assert.equal(document.querySelector<HTMLButtonElement>('button[aria-label="Session capabilities"]')?.disabled, true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    GlobalRegistrator.unregister()
  }
}
if (process.argv.includes('--fixture')) await fixture()
else test('session capability popover scopes toggles, resets overrides and blocks changes while busy', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, stderr || stdout)
}, 15_000)
