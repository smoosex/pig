/** Run React/module mocks in a child process so other suites retain their real modules. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'
import { PERSONA_FILES, type PersonaApi, type PersonaDocument, type PersonaSnapshot } from '../src/shared/persona'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  let snapshot: PersonaSnapshot = {
    active: false,
    files: PERSONA_FILES.map((name) => ({ name, content: '', revision: null })),
    mood: { pleasantness: 0, activation: 0.5, energy: 0.5, feeling: 'Calm and rested', description: 'A steady mood', automatic: false, observer: { enabled: false }, history: [{ pleasantness: 0, activation: 0.5, energy: 0.5, feeling: 'Rested', trigger: 'Task completed', timestamp: 1700000000000 }] }
  }
  let getCount = 0
  let changed: (() => void) | undefined
  let saved: PersonaDocument | undefined
  let settle: ((value: PersonaSnapshot) => void) | undefined
  let rejectSave = false
  let applied: Parameters<PersonaApi['setMood']>[0] | undefined
  let observed: Parameters<PersonaApi['setObserver']>[0] | undefined
  const persona: PersonaApi = {
    get: async () => { getCount++; return snapshot },
    saveFile: async (document) => {
      saved = document
      if (rejectSave) throw new Error('revision conflict')
      return new Promise<PersonaSnapshot>((resolve) => { settle = resolve })
    },
    setMood: async (values) => {
      applied = values
      snapshot = { ...snapshot, mood: { ...snapshot.mood, ...values } }
      return snapshot
    },
    setObserver: async (settings) => {
      observed = settings
      snapshot = { ...snapshot, mood: { ...snapshot.mood, observer: settings } }
      return snapshot
    },
    setAutomatic: async (automatic) => ({ ...snapshot, mood: { ...snapshot.mood, automatic } }),
    observerUsage: async (range) => ({
      range, models: [],
      totals: { requests: 0, measured: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, durationMs: 0, estimatedInput: 0 },
      outcomes: { changed: 0, unchanged: 0, invalid: 0, error: 0, timeout: 0, aborted: 0 },
    }),
    clearObserverUsage: async () => {},
    onChanged: (listener) => { changed = listener; return () => { changed = undefined } }
  }
  Object.assign(window, { api: { persona } })
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params) }))
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  useModelCatalogStore.setState({ models: [{ id: 'observer-test', name: 'Observer test', provider: 'test', providerName: 'Test provider', contextWindow: 10000, reasoning: true, thinkingLevels: ['off', 'low', 'high'] }] })
  const { PersonaSettings } = await import('../src/renderer/src/components/settings/PersonaSettings')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let dirty = false
  let busy = false
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!
  const click = async (text: string) => { await act(async () => { button(text).click() }) }
  const tab = async (name: string) => {
    await act(async () => {
      const node = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.textContent?.startsWith(name))!
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: false }))
    })
  }
  const edit = async (value: string) => {
    await act(async () => {
      const node = host.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  try {
    await act(async () => { root.render(h(TooltipProvider, null, h(PersonaSettings, { onDirtyChange: (value) => { dirty = value }, onBusyChange: (value) => { busy = value } }))) })
    assert.equal(getCount, 1)
    await edit('soul draft')
    assert.equal(dirty, true)
    await tab('USER.md')
    await edit('user draft')
    await tab('SOUL.md')
    assert.equal(host.querySelector('textarea')!.value, 'soul draft')
    assert.match(host.textContent!, /Calm and rested/)
    assert.match(host.textContent!, /additional model calls/)
    snapshot = { ...snapshot, mood: { ...snapshot.mood, feeling: 'Changed in a conversation' } }
    await act(async () => { changed!() })
    assert.match(host.textContent!, /Changed in a conversation/, 'a conversation change reaches the open page')
    assert.equal(host.querySelector('textarea')!.value, 'soul draft', 'unsaved drafts survive the reread')
    assert.match(host.textContent!, /not work capability/)
    const sliders = [...host.querySelectorAll<HTMLElement>('[role="slider"]')]
    assert.equal(sliders.length, 3)
    assert.equal(sliders[0].getAttribute('aria-valuemin'), '-1')
    assert.equal(sliders[1].getAttribute('aria-valuemin'), '0')
    assert.equal(sliders[2].getAttribute('aria-valuemax'), '1')
    await act(async () => {
      sliders[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    assert.deepEqual(applied, { pleasantness: 0.01, activation: 0.5, energy: 0.5 }, 'slider sends all three normalized dimensions')
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Mood observer"]')!.click() })
    assert.deepEqual(observed, { enabled: true })
    await click('Default')
    const defaultSwitch = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Default"]')!
    const modelSearch = () => document.querySelector<HTMLInputElement>('[aria-label="Search models"]')!
    assert.equal(defaultSwitch.closest('label'), null, 'a label must not wrap the switch and reactivate it after a click')
    assert.equal(defaultSwitch.getAttribute('aria-checked'), 'true')
    assert.equal(modelSearch().disabled, true)
    await act(async () => { defaultSwitch.click() })
    assert.equal(defaultSwitch.getAttribute('aria-checked'), 'false', 'default turns off instead of bouncing back on')
    assert.equal(modelSearch().disabled, false, 'turning default off unlocks search')
    const defaultLabel = document.querySelector<HTMLLabelElement>(`label[for="${defaultSwitch.id}"]`)!
    await act(async () => { defaultLabel.click() })
    assert.equal(defaultSwitch.getAttribute('aria-checked'), 'true', 'the adjacent label still operates the switch')
    await act(async () => { defaultLabel.click() })
    assert.equal(defaultSwitch.getAttribute('aria-checked'), 'false')
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.startsWith('Observer test'))!.click()
    })
    assert.deepEqual(observed, { enabled: true, provider: 'test', modelId: 'observer-test' })
    const raiseThinking = () => document.querySelector<HTMLButtonElement>('[aria-label="Raise thinking effort"]')!
    assert.ok(raiseThinking(), 'observer exposes the shared thinking-level controls')
    await act(async () => { raiseThinking().click() })
    assert.deepEqual(observed, { enabled: true, provider: 'test', modelId: 'observer-test', thinking: 'off' })
    await act(async () => { raiseThinking().click() })
    assert.deepEqual(observed, { enabled: true, provider: 'test', modelId: 'observer-test', thinking: 'low' })
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Default"]')!.click() })
    assert.deepEqual(observed, { enabled: true }, 'inherit clears both configured model fields')
    await act(async () => { host.querySelector<HTMLButtonElement>('fieldset button')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Automatic changes"]')!.click() })
    assert.equal(host.querySelector('[aria-label="Automatic changes"]')!.getAttribute('aria-checked'), 'true')
    assert.equal(host.querySelector('textarea')!.value, 'soul draft', 'mood reply preserves file drafts')
    await click('Save SOUL.md')
    assert.deepEqual(saved, { name: 'SOUL.md', content: 'soul draft', revision: null })
    assert.equal(busy, true)
    assert.equal(host.querySelector('textarea')!.disabled, true)
    assert.equal(button('Working…').disabled, true)
    snapshot = { ...snapshot, files: snapshot.files.map((document) => document.name === 'SOUL.md' ? { ...document, content: 'soul draft', revision: 'sha-soul' } : document) }
    await act(async () => { settle!(snapshot) })
    assert.equal(busy, false)
    assert.equal(dirty, true, 'saving one file does not clear another draft')
    await tab('USER.md')
    assert.equal(host.querySelector('textarea')!.value, 'user draft')
    rejectSave = true
    await click('Save USER.md')
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /revision conflict/)
    assert.equal(host.querySelector('textarea')!.value, 'user draft')
    rejectSave = false
    await click('Save USER.md')
    snapshot = { ...snapshot, files: snapshot.files.map((document) => document.name === 'USER.md' ? { ...document, content: 'user draft', revision: 'sha-user' } : document) }
    await act(async () => { settle!(snapshot) })
    assert.equal(dirty, false)
    await tab('SOUL.md')
    assert.equal(host.querySelector('textarea')!.value, 'soul draft')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('persona drafts preserve saved files, pending locks and revision conflicts', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10000)
  try {
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, errors || output)
  } finally { clearTimeout(timer); child.kill() }
}, 12000)
