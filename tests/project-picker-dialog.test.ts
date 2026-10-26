/** Exercise the in-app browser and its session-catalog action without leaking the DOM/module graph. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ProjectDirectoryListing, ProjectDirectorySearch, SessionApi } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = () => {}
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const calls: { path?: string; hidden?: boolean }[] = []
  const added: string[] = []
  let failAdd = false
  let nativeClose: (action: 'tab.close') => void = () => {}
  let pendingSave: Promise<void> | undefined
  let finishSave!: () => void
  let resolveSlow!: (value: ProjectDirectoryListing) => void
  const slow = new Promise<ProjectDirectoryListing>((resolve) => { resolveSlow = resolve })
  const searches: { path: string; query: string; hidden: boolean }[] = []
  let cancels = 0
  let resolveSlowSearch!: (value: ProjectDirectorySearch) => void
  const slowSearch = new Promise<ProjectDirectorySearch>((resolve) => { resolveSlowSearch = resolve })
  const listing = (path: string): ProjectDirectoryListing => ({
    path, home: '/home', parent: path === '/' ? null : path === '/home' ? '/' : '/home',
    breadcrumbs: [{ name: '/', path: '/' }, { name: 'home', path: '/home' }, ...(path !== '/home' ? [{ name: path.split('/').at(-1)!, path }] : [])],
    directories: path === '/home' ? ['alpha', 'beta', 'denied', 'slow'].map((name) => ({ name, path: `/home/${name}`, git: name === 'alpha' })) : [],
    truncated: false
  })
  const service = {
    browser: { onShortcutRequested: (listener: typeof nativeClose) => { nativeClose = listener; return () => { nativeClose = () => {} } } } as SessionApi['browser'],
    supportsGlass: false,
    browseProjectDirectories: async (path, hidden) => {
      calls.push({ path, hidden })
      if (path === '/home/slow') return slow
      if (path === '/home/denied') throw new Error('Permission denied')
      return listing(path ?? '/home')
    },
    searchProjectDirectories: async (path, query, hidden) => {
      searches.push({ path, query, hidden })
      if (query === 'slow') return slowSearch
      return {
        path, query, truncated: false,
        directories: [{ name: 'web-app', path: '/home/apps/web-app', relativePath: 'apps/web-app', git: true }]
      }
    },
    cancelProjectDirectorySearch: async () => { cancels++ },
    openProject: async (path) => {
      added.push(path)
      await pendingSave
      if (failAdd) throw new Error('Cannot save project')
      return { cwd: path, name: path.split('/').at(-1)!, sessions: [] }
    }
  } satisfies Partial<SessionApi>
  Object.assign(window, { api: service })
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en', localeSetting: 'en' })
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { ProjectPickerDialog } = await import('../src/renderer/src/components/projects/ProjectPickerDialog')
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await Bun.sleep(0) }) }
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => (node.getAttribute('aria-label') ?? node.textContent) === label)
    assert.ok(found, label)
    return found
  }
  const click = async (label: string) => { await act(async () => { button(label).click() }); await flush() }
  const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const type = async (label: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(label), value)
      input(label).dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const key = async (label: string, value: string) => {
    await act(async () => { input(label).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })) })
    await flush()
  }
  const toggle = async (label: string) => {
    const target = [...document.querySelectorAll<HTMLLabelElement>('label')].find((node) => node.textContent === label)!
    await act(async () => { document.getElementById(target.htmlFor)!.click() })
    await flush()
  }
  const path = 'Folder path'
  const search = 'Search folders in this directory…'
  try {
    await act(async () => { root.render(h(ProjectPickerDialog)) })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => { await useSessionsStore.getState().openProject() })
    await flush()
    assert.equal(added.length, 0, 'requesting the picker does not register a project')
    assert.equal(input(path).value, '/home')
    assert.equal(document.activeElement as Element | null, input(search))
    assert.equal(document.querySelectorAll('[role="option"]').length, 4)
    assert.ok(document.querySelector('[aria-label="Git repository"]'))
    await act(async () => { nativeClose('tab.close') })
    assert.equal(useSessionsStore.getState().projectPickerOpen, false, 'native menu close dismisses the picker')
    for (let attempt = 0; attempt < 20 && document.activeElement !== trigger; attempt++) {
      await act(async () => { await Bun.sleep(10) })
    }
    assert.equal(document.activeElement, trigger)
    await act(async () => { await useSessionsStore.getState().openProject() })
    await flush()

    await type(search, 'bet')
    await key(search, 'ArrowRight')
    assert.equal(input(path).value, '/home', 'text caret navigation does not open a folder')
    await key(search, 'Tab')
    assert.equal(input(search).value, 'beta')
    await key(search, 'Enter')
    assert.equal(input(path).value, '/home/beta')
    await click('Parent folder')
    assert.equal(input(path).value, '/home')
    await toggle('Show hidden folders')
    assert.equal(calls.at(-1)?.hidden, true)

    await toggle('Search subfolders')
    await type(search, 'slow')
    await act(async () => { await Bun.sleep(250) })
    await type(search, 'web')
    assert.equal(searches.length, 1, 'typing waits for a pause before walking the folder')
    assert.equal(cancels, 1, 'a new query stops the walk already running in main')
    await act(async () => { await Bun.sleep(250) })
    assert.deepEqual(searches.at(-1), { path: '/home', query: 'web', hidden: true })
    await act(async () => { resolveSlowSearch({ path: '/home', query: 'slow', truncated: false, directories: [] }) })
    await flush()
    const options = [...document.querySelectorAll('[role="option"]')]
    assert.equal(options.length, 1, 'a late result for an older query is ignored')
    assert.equal(options[0].textContent, 'web-appapps')
    await key(search, 'Enter')
    assert.equal(input(path).value, '/home/apps/web-app', 'a nested match opens directly')
    assert.equal(input(search).value, '')
    const cancelsBeforeOff = cancels
    await type(search, 'web')
    await act(async () => { await Bun.sleep(250) })
    await toggle('Search subfolders')
    assert.equal(cancels, cancelsBeforeOff + 1, 'turning search off stops its walk in main')
    await click('Home')

    await type(path, '/home/slow')
    await key(path, 'Enter')
    await type(path, '/home/beta')
    await key(path, 'Enter')
    await act(async () => { resolveSlow(listing('/home/slow')) })
    await flush()
    assert.equal(input(path).value, '/home/beta', 'a late directory response cannot replace the newer location')

    await type(path, '/home/denied')
    await key(path, 'Enter')
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Permission denied')
    assert.equal(button('Add current folder').disabled, true, 'an unsuccessful navigation cannot register the previous directory')
    await click('Home')
    failAdd = true
    await click('Add current folder')
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Cannot save project')
    assert.equal(button('Add current folder').disabled, false, 'a registration failure can be retried explicitly')
    failAdd = false
    pendingSave = new Promise<void>((resolve) => { finishSave = resolve })
    await act(async () => { input(search).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true })) })
    await flush()
    await act(async () => { nativeClose('tab.close') })
    assert.equal(useSessionsStore.getState().projectPickerOpen, true, 'native close respects the picker save lock')
    await act(async () => { finishSave() })
    await flush()
    assert.deepEqual(added, ['/home', '/home'])
    assert.equal(useSessionsStore.getState().projectPickerOpen, false)
    assert.equal(useSessionsStore.getState().projects[0].cwd, '/home')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    // Radix restores focus from its deferred FocusScope unmount callback.
    for (let attempt = 0; attempt < 20 && document.activeElement !== trigger; attempt++) {
      await act(async () => { await Bun.sleep(10) })
    }
    assert.equal(document.activeElement, trigger)
    await act(async () => { await useSessionsStore.getState().openProject() })
    await flush()
    await act(async () => { input(search).dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: true, bubbles: true })) })
    await flush()
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(added, ['/home', '/home'], 'cancelling does not register anything')
    useSettingsStore.setState({ shortcuts: { 'projectPicker.addCurrent': 'Alt+Enter' } })
    for (const label of [path, search]) {
      await act(async () => { await useSessionsStore.getState().openProject() })
      await flush()
      const browsed = calls.length
      await act(async () => { input(label).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', altKey: true, bubbles: true })) })
      await flush()
      assert.equal(calls.length, browsed, 'a bound Enter combination never navigates first')
      assert.equal(document.querySelector('[role="dialog"]'), null)
    }
    assert.deepEqual(added, ['/home', '/home', '/home', '/home'], 'the dialog shortcut wins over the inputs, adding once')
  } finally {
    await act(async () => { root.unmount() })
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('project picker browses in app, handles stale results and errors, and registers only after confirmation', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, errors || output)
  } finally { clearTimeout(timer); child.kill() }
}, 20_000)
