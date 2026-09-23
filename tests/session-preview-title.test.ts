import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'
import type { ProjectGroup, SessionMeta } from '../src/shared/api'

async function runFixture(): Promise<void> {
  // catalog.ts reaches window.api at module scope through ipc/api; a plain stub is enough because
  // nothing under test touches the DOM (the locale is pinned with setState, bypassing publish()).
  Object.defineProperty(globalThis, 'window', { value: { api: {} }, configurable: true })
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { fallbackTitle, sessionTitle } = await import('../src/renderer/src/stores/sessions/session-title')
  const { fillEmptySessionTitle, patchTabsFromGroups } = await import('../src/renderer/src/stores/sessions/catalog')

  const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
    path: '/sessions/s1.jsonl',
    id: 's1',
    cwd: '/project',
    created: '',
    modified: '',
    size: 0,
    firstMessage: '',
    ...overrides
  })
  const tab = (overrides: Partial<OpenTab> = {}): OpenTab => ({
    id: 's1',
    cwd: '/project',
    title: '新对话',
    kind: 'project',
    loadState: 'ready',
    ...overrides
  })
  const group = (sessions: SessionMeta[]): ProjectGroup => ({ cwd: '/project', name: 'project', sessions })

  // A listing with nothing to show keeps the tab's title instead of resetting it to the placeholder.
  const kept = patchTabsFromGroups([tab({ title: '帮我修登录' })], [group([meta()])])
  assert.equal(kept[0]?.title, '帮我修登录')
  assert.equal(kept[0]?.meta?.id, 's1')

  // A preview marker translates the title and follows the fresh listing.
  const filled = fillEmptySessionTitle([group([meta()])], 's1', '图片', 'image')
  assert.equal(filled[0]?.sessions[0]?.firstMessage, '')
  assert.equal(filled[0]?.sessions[0]?.previewFallback, 'image')
  assert.equal(sessionTitle(filled[0]?.sessions[0] as SessionMeta), '图片')

  const previewed = patchTabsFromGroups([tab()], [group([meta({ firstMessage: '图片', previewFallback: 'image' })])])
  assert.equal(previewed[0]?.title, '图片')
  assert.equal(previewed[0]?.previewFallback, 'image')

  // The scan caught up with a real message: the stale marker on the tab goes with it.
  const scanned = patchTabsFromGroups(
    [tab({ title: '图片', previewFallback: 'image' })],
    [group([meta({ firstMessage: '帮我修登录' })])]
  )
  assert.equal(scanned[0]?.title, '帮我修登录')
  assert.equal(scanned[0]?.previewFallback, undefined)

  // A preview marker follows the locale switch instead of freezing the old word.
  assert.equal(fallbackTitle('pastedText'), '粘贴的文本')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  assert.equal(fallbackTitle('pastedText'), 'Pasted text')
  assert.equal(fallbackTitle('image'), 'Image')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })

  // A real name shadows the marker instead of spending it.
  const { renameGroupSession } = await import('../src/renderer/src/stores/sessions/catalog')
  const marked = group([meta({ previewFallback: 'pastedText' })])
  const renamed = renameGroupSession([marked], 's1', '名字')
  assert.equal(renamed[0]?.sessions[0]?.name, '名字')
  assert.equal(renamed[0]?.sessions[0]?.previewFallback, 'pastedText')
  assert.equal(sessionTitle(renamed[0]?.sessions[0] as SessionMeta), '名字')

  // Clearing the name hands the title back to a freshly translated word, not a frozen one.
  const cleared = renameGroupSession(renamed, 's1', undefined)
  assert.equal(cleared[0]?.sessions[0]?.name, undefined)
  assert.equal(cleared[0]?.sessions[0]?.firstMessage, '')
  assert.equal(sessionTitle(cleared[0]?.sessions[0] as SessionMeta), '粘贴的文本')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  assert.equal(sessionTitle(cleared[0]?.sessions[0] as SessionMeta), 'Pasted text')
}

if (process.argv[2] === '--session-preview-title-fixture') {
  await runFixture()
} else {
  test('preview titles keep the tab, translate the marker and follow the listing', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--session-preview-title-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}
