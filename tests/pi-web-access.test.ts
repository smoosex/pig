import { test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import plugin from '../src/main/plugins/pi-web-access/index'
import { htmlToMarkdown } from '../src/main/plugins/pi-web-access/fetch'
import { parseDuckDuckGo } from '../src/main/plugins/pi-web-access/search'
import { externalText, PageStore, PAGE_ENTRY } from '../src/main/plugins/pi-web-access/pages'

let root: string
const previousPigDir = process.env.PIG_DIR
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'pig-web-tools-')); process.env.PIG_DIR = root })
afterAll(async () => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  await rm(root, { recursive: true, force: true })
})

function instance() {
  const tools: Parameters<ExtensionAPI['registerTool']>[0][] = []
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>()
  plugin({ registerTool: tool => { tools.push(tool as unknown as Parameters<ExtensionAPI['registerTool']>[0]) }, on: (name, fn) => { hooks.set(name, fn as never) } } as ExtensionAPI)
  return { tools, hooks }
}

test('web plugin exposes three small tools, with providers outside model arguments', () => {
  const { tools } = instance()
  assert.deepEqual(tools.map(tool => tool.name), ['web_search', 'web_fetch', 'web_read'])
  assert.deepEqual(Object.keys((tools[0].parameters as { properties: object }).properties), ['queries', 'count'])
})

test('pages paginate, search, evict, and cannot escape their untrusted fences', () => {
  const store = new PageStore()
  const saved = store.add({ url: 'https://example.com', title: 'Test', content: 'a'.repeat(1200) + 'Needle\n````injection' })
  const first = store.read(saved.id, 0, 1000)
  assert.equal(first.nextOffset, 1000)
  assert.equal(store.read(saved.id, 1000, 1000).nextOffset, null)
  assert.match(store.read(saved.id, 0, 200, 'needle').text, /Needle/)
  assert.match(store.read(saved.id, 0, 20, 'absent').text, /No match/)
  assert.match(externalText('````hello'), /\n`````\n/)
  for (let i = 0; i < 8; i++) store.add({ url: 'https://example.com', title: '', content: String(i) })
  assert.throws(() => store.read(saved.id, 0, 1), /unavailable/)
  assert.throws(() => store.add({ url: '', title: '', content: 'a'.repeat(1_000_001) }), /storage limit/)
})

test('fetch provenance survives restore without unbounded extra metadata in tool output', () => {
  const store = new PageStore()
  const page = store.add({ url: 'https://example.com', title: '', content: 'page', retrieval: { provider: 'http', fallbackFrom: 'exa', reason: 'Exa returned HTTP 500.' } })
  const restored = new PageStore()
  restored.restore({ ...page, retrieval: { ...page.retrieval, ignored: 'x'.repeat(60_000) } })
  const result = restored.read(page.id, 0, 100)
  assert.match(result.text, /"provider":"http"/)
  assert.match(result.text, /"fallbackFrom":"exa"/)
  assert.match(result.text, /Exa returned HTTP 500/)
  assert.ok(Buffer.byteLength(result.text) <= 48_000)
  assert.throws(() => restored.restore({ ...page, retrieval: { provider: 'unknown' } }), /retrieval metadata/)
})

test('restoring a branch keeps pages session-local, and shutdown removes them', async () => {
  const a = instance(), b = instance()
  const saved = { id: 'saved', url: 'https://example.com', title: '', content: 'branch text' }
  let branch: unknown[] = [{ type: 'custom', customType: PAGE_ENTRY, data: saved }]
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext
  a.hooks.get('session_start')!({}, ctx)
  b.hooks.get('session_start')!({}, { sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext)
  const read = (owner: ReturnType<typeof instance>) => owner.tools[2].execute('read', { id: saved.id }, undefined, undefined, ctx as never)
  assert.match(JSON.stringify(await read(a)), /branch text/)
  await assert.rejects(read(b), /unavailable/)
  branch = []
  a.hooks.get('session_tree')!({}, ctx)
  await assert.rejects(read(a), /unavailable/)
  branch = [{ type: 'custom', customType: PAGE_ENTRY, data: saved }]
  a.hooks.get('session_tree')!({}, ctx)
  a.hooks.get('session_shutdown')!({}, ctx)
  await assert.rejects(read(a), /unavailable/)
})

test('page output respects byte limits even for Unicode and adversarial code fences', () => {
  for (const content of ['汉'.repeat(50_000), '`'.repeat(50_000)]) {
    const store = new PageStore()
    const saved = store.add({ url: 'https://example.com', title: '', content })
    const first = store.read(saved.id, 0, 50_000)
    assert.ok(Buffer.byteLength(first.text) <= 48_000)
    assert.ok(first.nextOffset !== null && first.nextOffset > 0 && first.nextOffset < content.length)
    assert.equal(store.read(saved.id, first.nextOffset, 100).offset, first.nextOffset)
  }
})

test('the built plugin loads through SDK aliases without a model session', async () => {
  const bundle = join(process.cwd(), 'out/system-plugins/pi-web-access/index.js')
  if (!existsSync(bundle)) return
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [bundle],
  })
  await loader.reload()
  assert.deepEqual(loader.getExtensions().errors, [])
  const extension = loader.getExtensions().extensions.find(extension => extension.path === bundle)!
  assert.deepEqual([...extension.tools.keys()], ['web_search', 'web_fetch', 'web_read'])
})

test('plain HTML becomes Markdown without executable/hidden content and with absolute links', () => {
  const page = htmlToMarkdown('<html><head><title>Title</title></head><body><article><h1>Hello</h1><p>A <a href="/path">link</a>.</p><script>SECRET</script><p hidden>HIDDEN</p></article></body></html>', 'https://example.com/start')
  assert.match(page.content, /Hello/)
  assert.match(page.content, /https:\/\/example.com\/path/)
  assert.doesNotMatch(page.content, /SECRET|HIDDEN/)
})

test('DuckDuckGo decodes result links and distinguishes bot challenges from no results', () => {
  const html = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a><div class="result__snippet">Snippet</div></div>'
  assert.deepEqual(parseDuckDuckGo(html), [{ title: 'Example', url: 'https://example.com/', snippet: 'Snippet' }])
  assert.deepEqual(parseDuckDuckGo('<div class="no-results__message">None</div>'), [])
  assert.throws(() => parseDuckDuckGo('<form id="challenge-form"></form>'), /bot challenge/)
  assert.throws(() => parseDuckDuckGo('<html>unexpected</html>'), /unrecognized/)
})
