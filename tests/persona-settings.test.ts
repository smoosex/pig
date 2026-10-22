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
    mood: { emotion: 'joy', intensity: 0.5, angle: 0, level: 1, description: '', phrase: '', automatic: false, history: [] }
  }
  let getCount = 0
  let saved: PersonaDocument | undefined
  let settle: ((value: PersonaSnapshot) => void) | undefined
  let rejectSave = false
  let applied: [string, number] | undefined
  const persona: PersonaApi = {
    get: async () => { getCount++; return snapshot },
    saveFile: async (document) => {
      saved = document
      if (rejectSave) throw new Error('revision conflict')
      return new Promise<PersonaSnapshot>((resolve) => { settle = resolve })
    },
    setEmotion: async (emotion, intensity) => {
      applied = [emotion, intensity]
      return { ...snapshot, mood: { ...snapshot.mood, emotion, intensity } }
    },
    setAutomatic: async (automatic) => ({ ...snapshot, mood: { ...snapshot.mood, automatic } })
  }
  Object.assign(window, { api: { persona } })
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params) }))
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
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Adjust mood"]')!.click() })
    await click('Trust')
    assert.deepEqual(applied, ['trust', 0.5], 'percentage controls send normalized emotion strength')
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
