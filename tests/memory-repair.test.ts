import { test, mock, spyOn } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--repair-fixture')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-memory-repair-')))
  process.env.PIG_DIR = root
  const { MemoryFiles, memoryRoot, revisionOf } = await import('../src/main/features/memory/long-term/files')
  const { inspectMemoryDirectory } = await import('../src/main/features/memory/long-term/inventory')
  const live = new MemoryFiles(memoryRoot())
  const projectId = 'a'.repeat(64)
  let mode = 'default', requests = 0, scenario = 'good'
  const original = 'Never push without an explicit user request.'
  let longOriginal = '', reconstructed = '', pages = 0
  const fresh = () => live.save('git-rules.md', original, live.optional('git-rules.md')?.revision ?? null)
  mock.module('../src/main/pig-dir', () => ({ pigPath: (...parts: string[]) => join(root, ...parts) }))
  mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ fileMemory: { enabled: false } }) }))
  mock.module('../src/main/permissions/store', () => ({ sessionPermission: () => ({ mode }), readPermissionSettings: () => ({ defaultMode: mode }), onPermissionsChanged: () => () => {} }))
  mock.module('../src/main/features/memory/long-term/catalog', () => ({ listMemoryFiles: async () => inspectMemoryDirectory(memoryRoot()).files,
    listMemoryProjects: async () => [{ id: projectId, name: 'Verified project', cwd: '/verified' }] }))
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const { createAssistantMessageEventStream, getCurrentTools } = await import('@earendil-works/pi-ai')
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') })
  runtime.registerProvider('repair-fixture', { api: 'openai-completions', baseUrl: 'http://unused.invalid', apiKey: 'fixture-only', models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
  await runtime.setRuntimeApiKey('repair-fixture', 'fixture-only')
  mock.module('../src/main/pi/model-settings', () => ({ startModelRuntime: async () => runtime,
    readDefaultSettings: async () => ({ effective: { model: { provider: 'repair-fixture', id: 'model' }, thinkingLevel: 'off' } }) }))
  const stream = spyOn(runtime, 'streamSimple').mockImplementation((model, context) => {
    assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(), ['memory_add', 'memory_delete', 'memory_edit', 'memory_read', 'repair_delete', 'repair_read'])
    const turn = requests++
    if (scenario === 'conflict' && turn === 0) live.save('git-rules.md', 'Concurrent edit', live.read('git-rules.md').revision)
    const call = (name: string, args: Record<string, string | number>) => ({ type: 'toolCall' as const, id: name + turn, name, arguments: args })
    const content = scenario === 'long' ? (() => {
      if (turn === 0) return [call('repair_read', { path: 'git-rules.md' })]
      if (turn > 2) return [{ type: 'text' as const, text: 'Preserved the long-line original in a paged topic note.' }]
      const reply = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'repair_read')
      assert.ok(reply?.role === 'toolResult' && !reply.isError)
      const text = reply.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const page = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!) as { file: { content: string; revision: string }; nextOffset: number | null }
      assert.ok(Buffer.byteLength(page.file.content) <= 16000)
      assert.equal(page.file.revision, revisionOf(longOriginal), 'all chunks retain the full-file revision')
      reconstructed += page.file.content; pages++
      if (page.nextOffset !== null) return [call('repair_read', { path: 'git-rules.md', offset: page.nextOffset })]
      assert.equal(reconstructed, longOriginal, 'UTF-8 chunk boundaries preserve every character')
      const wrapped = Array.from(longOriginal).reduce<string[]>((lines, character, index) => {
        if (index % 1000 === 0) lines.push('')
        lines[lines.length - 1] += character
        return lines
      }, []).join('\n')
      return [call('memory_add', { scope: 'global', path: 'long.md', content: wrapped }),
        call('memory_add', { scope: 'global', path: 'MEMORY.md', content: '[Long note](long.md)' }),
        call('repair_delete', { path: 'git-rules.md', revision: page.file.revision })]
    })() : turn === 0 ? [call('repair_read', {})]
      : turn === 1 ? [call('repair_read', { path: 'git-rules.md' })]
      : turn === 2 ? scenario === 'scope' ? [call('memory_add', { scope: 'project', projectId: 'b'.repeat(64), path: 'bad.md', content: original })]
        : scenario === 'conflict' ? [call('repair_delete', { path: 'git-rules.md', revision: revisionOf(original) })]
        : [call('memory_add', { scope: 'project', projectId, path: 'rules/git.md', content: original }),
          call('memory_add', { scope: 'project', projectId, path: 'MEMORY.md', content: '[Git rules](rules/git.md)' }),
          call('repair_delete', { path: 'git-rules.md', revision: revisionOf(original) })]
      : [{ type: 'text' as const, text: 'Moved the misplaced rule and updated its project index. Other files were left unchanged.' }]
    const output = createAssistantMessageEventStream()
    output.push({ type: 'done', reason: turn < 3 ? 'toolUse' : 'stop', message: {
      role: 'assistant', timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id, content,
      stopReason: turn < 3 ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    } })
    return output
  })
  try {
    fresh()
    // Broken unrelated files must remain intact and must not prevent narrow repair.
    mkdirSync(join(memoryRoot(), 'global'), { recursive: true })
    writeFileSync(join(memoryRoot(), 'global', 'oversized.md'), 'x'.repeat(65537))
    const { DreamService, validateDreamRequest } = await import('../src/main/features/memory/dream/service')
    const service = new DreamService(async () => { throw new Error('Repair must not discover historical conversations') })
    const settle = async () => {
      for (let i = 0; i < 300 && service.status().state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5))
      return service.status()
    }
    assert.doesNotThrow(() => validateDreamRequest({ repair: true }))
    assert.throws(() => validateDreamRequest({ repair: true, topic: 'unrelated' }))
    service.start(1, { repair: true })
    let status = await settle()
    assert.equal(status.state, 'done', JSON.stringify(status))
    assert.equal(status.repair, true)
    assert.equal(existsSync(join(memoryRoot(), 'git-rules.md')), false)
    assert.equal(live.read(`projects/${projectId}/rules/git.md`).content, original)
    assert.equal(live.read(`projects/${projectId}/MEMORY.md`).content, '[Git rules](rules/git.md)')
    assert.equal(readFileSync(join(root, 'dream', status.id!, 'before', 'git-rules.md'), 'utf8'), original)
    assert.equal(statSync(join(root, 'dream', status.id!, 'session.jsonl')).mode & 0o777, 0o600)
    const transcript = readFileSync(join(root, 'dream', status.id!, 'session.jsonl'), 'utf8')
    assert.match(transcript, /Verified project/)
    assert.match(transcript, /git-rules.md/)
    assert.equal(statSync(join(memoryRoot(), 'global', 'oversized.md')).size, 65537)
    assert.equal(JSON.parse(readFileSync(join(root, 'dream', status.id!, 'result.json'), 'utf8')).repair, true)
    // The ordinary store intentionally remains strict for externally broken catalogs.
    rmSync(join(memoryRoot(), 'global', 'oversized.md'))
    for (const text of ['a'.repeat(16001), 'a'.repeat(15999) + '😀' + '中'.repeat(3000)]) {
      longOriginal = text; reconstructed = ''; pages = 0; requests = 0; scenario = 'long'
      writeFileSync(join(memoryRoot(), 'git-rules.md'), text)
      assert.equal(inspectMemoryDirectory(memoryRoot()).files.find(file => file.path === 'git-rules.md')?.repairable, true)
      service.start(1, { repair: true }); status = await settle()
      assert.equal(status.state, 'done', JSON.stringify(status))
      assert.equal(pages, 2)
      assert.equal(existsSync(join(memoryRoot(), 'git-rules.md')), false)
      assert.equal(live.read('global/long.md').content.replaceAll('\n', ''), text)
      assert.equal(readFileSync(join(root, 'dream', status.id!, 'before', 'git-rules.md'), 'utf8'), text)
      for (const path of ['global/long.md', 'global/MEMORY.md']) live.delete(path, live.read(path).revision)
    }
    for (const next of ['scope', 'conflict']) {
      fresh(); requests = 0; scenario = next
      service.start(1, { repair: true }); status = await settle()
      assert.equal(status.state, 'error')
      assert.equal(status.error, next === 'scope' ? 'DREAM_TOOL' : 'DREAM_CONFLICT')
      assert.equal(live.read('git-rules.md').content, next === 'scope' ? original : 'Concurrent edit')
      assert.deepEqual(status.changes, [])
    }
    requests = 0; mode = 'read-only'
    service.start(1, { repair: true }); status = await settle()
    assert.equal(status.error, 'DREAM_PERMISSION')
    assert.equal(requests, 0)
  } finally { stream.mockRestore(); rmSync(root, { recursive: true, force: true }) }
} else test('dedicated repair works with memory disabled, preserves backups, excludes history and rejects scopes/conflicts', async () => {
  const result = await runSelf(import.meta.path, ['--repair-fixture'], { timeoutMs: 20000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
}, 25000)
