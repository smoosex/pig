import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { compile } from '@earendil-works/pi-schema'
import { runSelf } from './helpers/subprocess'

async function fixture(): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-file-memory-extension-')))
  process.env.PIG_DIR = root
  let enabled = true
  let mode = 'default'
  let project = 'project-a'
  const modulePath = (name: string) => fileURLToPath(new URL(name, import.meta.url))
  mock.module(modulePath('../src/main/features/memory-settings.ts'), () => ({ getMemorySettings: async () => ({ fileMemory: { enabled } }) }))
  mock.module(modulePath('../src/main/permissions/store.ts'), () => ({ sessionPermission: () => ({ mode }) }))
  mock.module(modulePath('../src/main/features/memory/long-term/access.ts'), () => ({ memoryAccess: async () => ({ project, session: 'session', cwd: '/project' }) }))
  const { registerLongTermMemory, MEMORY_GUIDANCE } = await import('../src/main/features/memory/long-term/extension')
  const { MemoryFiles, memoryRoot, projectMemoryKey } = await import('../src/main/features/memory/long-term/files')
  const tools = new Map<string, any>()
  const events = new Map<string, Array<(...args: any[]) => any>>()
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()],
    on: (event: string, handler: (...args: any[]) => any) => events.set(event, [...(events.get(event) ?? []), handler])
  } as unknown as ExtensionAPI
  const ctx = { cwd: '/project', sessionManager: { getSessionId: () => 'session' } }
  const call = (name: string, params: object, signal = new AbortController().signal) => tools.get(name).execute('id', params, signal, undefined, ctx)
  const prompt = async (sections: Record<string, string> = {}) => {
    const event = { systemPromptOptions: { sections } }
    for (const handler of events.get('before_agent_start') ?? []) assert.equal(await handler(event, ctx), undefined, 'memory only mutates sections, never returns a message or forced prompt')
    return sections
  }
  try {
    enabled = false
    await registerLongTermMemory({
      registerTool: () => { throw new Error('Disabled memory must not register tools') },
      on: () => { throw new Error('Disabled memory must not register prompt hooks') }
    } as unknown as ExtensionAPI)
    enabled = true
    await registerLongTermMemory(pi)
    assert.equal(memoryRoot(), join(root, 'memory'), 'global and project scopes live directly under memory/')
    assert.deepEqual([...tools.keys()], ['memory_read', 'memory_add', 'memory_edit', 'memory_delete'])
    assert.deepEqual([...events.keys()], ['before_agent_start'], 'no per-request context injection')
    for (const tool of tools.values()) assert.equal(tool.exposure, 'deferred')
    assert.match(MEMORY_GUIDANCE, /global and current project memories/)
    assert.match(MEMORY_GUIDANCE, /tool_search.*names start with memory_/)
    assert.match(MEMORY_GUIDANCE, /All memory operations must go through memory tools/)
    assert.match(MEMORY_GUIDANCE, /First read MEMORY.md.*scope="global".*scope="project".*path="MEMORY.md"/)
    assert.match(MEMORY_GUIDANCE, /If the index is missing or empty, list the memory files/)
    assert.match(MEMORY_GUIDANCE, /Keep individual files small and use links/)
    assert.match(tools.get('memory_read').description, /only scope to list memory files/)
    assert.match(tools.get('memory_read').description, /query to search keywords/)
    assert.match(tools.get('memory_read').description, /index file is MEMORY.md/)
    assert.match(tools.get('memory_read').description, /nextOffset as offset/)
    assert.match(tools.get('memory_edit').description, /oldText.*newText/)
    for (const name of ['memory_add', 'memory_edit']) assert.match(tools.get(name).description, /MEMORY.md.*create it if missing/)
    for (const tool of tools.values()) assert.doesNotMatch(tool.description, /Markdown|[\u3400-\u9fff]/)
    assert.ok(MEMORY_GUIDANCE.length < 1000, 'the common instructions stay brief')
    const initial = await prompt()
    assert.equal(initial.memory, MEMORY_GUIDANCE)
    assert.doesNotMatch(initial.memory, /## global index|## project index/)
    assert.match(initial.pig_servers, /- memory \(tool_search\)/)
    const index = '[Cancellation](cancellation.md)'
    const added = await call('memory_add', { scope: 'global', path: 'cancellation.md', content: 'TOPIC DETAILS ARE LAZY' })
    assert.match(added.content[0].text, /Memory saved.*MEMORY.md.*create it if missing/)
    const globalStore = new MemoryFiles(join(memoryRoot(), 'global'))
    await assert.rejects(call('memory_add', { scope: 'global', path: 'cancellation.md', content: 'duplicate' }), { code: 'MEMORY_ALREADY_EXISTS' })
    await assert.rejects(call('memory_read', { scope: 'project', path: 'nope.md' }), (error: unknown) => {
      const failure = error as NodeJS.ErrnoException
      assert.equal(failure.code, 'ENOENT')
      assert.ok(failure.message.includes('nope.md'))
      assert.ok(!failure.message.includes(root))
      assert.equal(failure.path, undefined)
      return true
    })
    assert.equal(globalStore.optional('MEMORY.md'), undefined, 'writing a topic never fabricates an index')
    const missing = await prompt()
    assert.deepEqual(missing, initial, 'missing indexes do not add file-state information to the prompt')
    assert.doesNotMatch(missing.memory, /TOPIC DETAILS/)
    assert.match((await call('memory_read', { scope: 'global' })).content[0].text, /cancellation.md/)
    assert.match((await call('memory_read', { scope: 'global', query: 'TOPIC DETAILS' })).content[0].text, /cancellation.md/)
    await call('memory_add', { scope: 'project', path: 'unindexed.md', content: 'UNINDEXED PROJECT NOTE' })
    assert.deepEqual(await prompt(), initial)
    assert.match((await call('memory_read', { scope: 'project' })).content[0].text, /unindexed.md/)
    const blank = ''
    const createdIndex = await call('memory_add', { scope: 'global', path: 'MEMORY.md', content: blank })
    assert.equal(JSON.parse(createdIndex.content[0].text.split('\n')[2]).reminder, undefined, 'index writes do not prompt an index-maintenance loop')
    const emptyIndex = await prompt()
    assert.deepEqual(emptyIndex, initial, 'empty indexes are also read only through memory tools')
    const emptyRevision = globalStore.read('MEMORY.md').revision
    const fillIndex = { scope: 'global', path: 'MEMORY.md', revision: emptyRevision, oldText: '', newText: index }
    assert.ok(compile(tools.get('memory_edit').parameters).check(fillIndex), 'the tool schema allows empty oldText')
    await assert.rejects(call('memory_edit', { ...fillIndex, revision: '0'.repeat(64) }), { code: 'MEMORY_REVISION_CONFLICT' })
    assert.equal(globalStore.read('MEMORY.md').content, '')
    const updatedIndex = await call('memory_edit', fillIndex)
    assert.equal(globalStore.read('MEMORY.md').content, index, 'empty indexes are filled in place without delete/add')
    assert.equal(JSON.parse(updatedIndex.content[0].text.split('\n')[2]).reminder, undefined)
    await assert.rejects(call('memory_edit', fillIndex), { code: 'MEMORY_REVISION_CONFLICT' }, 'stale empty-file revisions cannot overwrite later content')
    await assert.rejects(call('memory_edit', { ...fillIndex, revision: globalStore.read('MEMORY.md').revision }), /completely empty/)
    await call('memory_add', { scope: 'global', path: 'whitespace.md', content: ' \n ' })
    await assert.rejects(call('memory_edit', { scope: 'global', path: 'whitespace.md', revision: globalStore.read('whitespace.md').revision, oldText: '', newText: 'no' }), /completely empty/)
    assert.equal(globalStore.read('whitespace.md').content, ' \n ')
    await call('memory_add', { scope: 'project', path: 'MEMORY.md', content: 'PROJECT A INDEX' })
    const injected = await prompt()
    assert.deepEqual(injected, initial, 'creating indexes never injects their contents')
    assert.doesNotMatch(injected.memory, /Cancellation|PROJECT A INDEX|TOPIC DETAILS/)
    await call('memory_add', { scope: 'global', path: 'testing.md', content: 'GLOBAL TEST COMMAND' })
    await call('memory_add', { scope: 'project', path: 'testing.md', content: 'PROJECT TEST COMMAND' })
    await call('memory_add', { scope: 'project', path: 'guides/start.md', content: '[Tests](../testing.md)' })
    assert.match((await call('memory_read', { scope: 'project', path: 'testing.md' })).content[0].text, /PROJECT TEST COMMAND/)
    assert.doesNotMatch((await call('memory_read', { scope: 'project', path: 'testing.md' })).content[0].text, /GLOBAL TEST COMMAND/)
    assert.match((await call('memory_read', { scope: 'global', path: 'testing.md' })).content[0].text, /GLOBAL TEST COMMAND/)
    assert.match((await call('memory_read', { scope: 'project', path: 'guides/start.md' })).content[0].text, /\.\.\/testing.md/)
    assert.match(tools.get('memory_read').description, /pass its path unchanged as path/)
    const indexRead = await call('memory_read', { scope: 'global', path: 'MEMORY.md' })
    assert.match(indexRead.content[0].text, /Cancellation/)
    const linkedRead = await call('memory_read', { scope: 'project', from: 'guides/start.md', path: '../testing.md' })
    const linked = JSON.parse(linkedRead.content[0].text.split('\n')[2]).file
    assert.equal(linked.path, 'testing.md')
    assert.equal(linked.content, 'PROJECT TEST COMMAND')
    assert.doesNotMatch(linkedRead.content[0].text, /GLOBAL TEST COMMAND/)
    await call('memory_edit', { scope: 'project', path: linked.path, revision: linked.revision, oldText: linked.content, newText: 'PROJECT UPDATED' })
    const reread = await call('memory_read', { scope: 'project', from: 'MEMORY.md', path: './testing.md' })
    const updated = JSON.parse(reread.content[0].text.split('\n')[2]).file
    assert.equal(updated.path, linked.path)
    assert.equal(updated.content, 'PROJECT UPDATED')
    await call('memory_delete', { scope: 'project', path: updated.path, revision: updated.revision })
    await assert.rejects(call('memory_read', { scope: 'project', from: 'guides/start.md', path: '../../global/testing.md' }), { code: 'MEMORY_LINK_OUTSIDE_SCOPE' })
    await assert.rejects(call('memory_read', { scope: 'project', from: 'guides/start.md' }))
    await assert.rejects(call('memory_read', { scope: 'project', from: 'guides/start.md', query: 'test' }))
    await assert.rejects(call('memory_read', { scope: 'project', from: 'guides/start.md', path: '../testing.md', query: 'test' }))
    assert.deepEqual(await prompt(), injected, 'unchanged files produce byte-identical sections')
    project = 'project-b'
    assert.doesNotMatch((await prompt()).memory, /PROJECT A INDEX/)
    const empty = await call('memory_read', { scope: 'project' })
    assert.match(empty.content[0].text, /"files":\[\]/)
    project = 'chat:session'
    const chat = (await prompt()).memory
    assert.equal(chat, MEMORY_GUIDANCE)
    assert.doesNotMatch(chat, /## project index|PROJECT A INDEX/)
    await assert.rejects(call('memory_add', { scope: 'project', path: 'a.md', content: 'no' }), /Chat/)
    project = 'project-a'
    const files = new MemoryFiles(join(memoryRoot(), 'global'))
    const before = files.read('cancellation.md')
    const edited = await call('memory_edit', { scope: 'global', path: 'cancellation.md', revision: before.revision, oldText: 'TOPIC DETAILS', newText: '$& local change' })
    assert.match(edited.content[0].text, /Memory saved.*MEMORY.md.*maintain useful entry links/)
    assert.equal(files.read('cancellation.md').content, '$& local change ARE LAZY')
    await assert.rejects(call('memory_edit', { scope: 'global', path: 'cancellation.md', revision: before.revision, oldText: 'ARE', newText: 'WERE' }), { code: 'MEMORY_REVISION_CONFLICT' })
    mode = 'read-only'
    await assert.rejects(call('memory_add', { scope: 'global', path: 'no.md', content: 'no' }), /Read-only/)
    await assert.rejects(call('memory_delete', { scope: 'global', path: 'cancellation.md', revision: files.read('cancellation.md').revision }), /Read-only/)
    assert.match((await call('memory_read', { scope: 'global', query: 'local change' })).content[0].text, /cancellation.md/)
    mode = 'default'
    const controller = new AbortController(); controller.abort()
    await assert.rejects(call('memory_delete', { scope: 'global', path: 'cancellation.md', revision: files.read('cancellation.md').revision }, controller.signal))
    assert.ok(files.optional('cancellation.md'))
    await call('memory_delete', { scope: 'global', path: 'cancellation.md', revision: files.read('cancellation.md').revision })
    assert.equal(files.optional('cancellation.md'), undefined)
    enabled = false
    assert.equal((await prompt({ memory: injected.memory })).memory, undefined)
    await assert.rejects(call('memory_read', { scope: 'global' }), /disabled/)
    assert.ok(new MemoryFiles(join(memoryRoot(), 'projects', projectMemoryKey('project-a'))).optional('MEMORY.md'))
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'memory', 'long-term.sqlite'), 'OLD DATABASE MUST NOT BE READ')
    enabled = true
    assert.equal((await prompt()).memory, MEMORY_GUIDANCE, 'legacy SQLite has no runtime role')
    const read = MemoryFiles.prototype.read
    MemoryFiles.prototype.read = () => { throw new Error('Prompt generation must not read memory files') }
    try {
      assert.deepEqual(await prompt(), initial, 'prompt generation does no memory-file reads')
    } finally { MemoryFiles.prototype.read = read }

    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [registerLongTermMemory]
    })
    await loader.reload()
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
    })
    try {
      await session.bindExtensions({ mode: 'rpc', onError: error => { throw new Error(error.error) } })
      const prepare = async () => {
        const run = session as unknown as { _prepareRun(trigger: unknown): Promise<{ role: string; sections?: Record<string, string | null> }[]> }
        const messages = await run._prepareRun({ messageType: 'user', prompt: 'hi', images: [] })
        assert.equal(messages.filter(message => message.role === 'user').length, 1, 'only the real user request, no synthetic memory message')
        return messages.find(message => message.role === 'system')?.sections
      }
      const record = (sections: Record<string, string | null>) => session.agent.state.messages.push({ role: 'system', content: '', sections, timestamp: 1 } as never)
      const baseline = (await prepare())!
      assert.equal(baseline.memory, `<memory>\n${MEMORY_GUIDANCE}\n</memory>`)
      assert.doesNotMatch(baseline.memory!, /Cancellation|PROJECT A INDEX/)
      record(baseline)
      assert.equal(await prepare(), undefined, 'unchanged guidance produces no SDK prompt patch')
      record({ memory: 'OLD AUTOMATIC INDEX CONTENT' })
      const replacement = (await prepare())!
      assert.deepEqual(replacement, { memory: baseline.memory }, 'old index-bearing sections are replaced with guidance only')
      record(replacement)
      await call('memory_edit', { scope: 'global', path: 'MEMORY.md', revision: files.read('MEMORY.md').revision, oldText: index, newText: '[New link](next.md)' })
      assert.equal(await prepare(), undefined, 'editing indexes never changes the system prompt')
      assert.match((await call('memory_read', { scope: 'global', path: 'MEMORY.md' })).content[0].text, /New link/)
      await call('memory_delete', { scope: 'global', path: 'MEMORY.md', revision: files.read('MEMORY.md').revision })
      assert.equal(await prepare(), undefined, 'deleting indexes never changes the system prompt')
      assert.match((await call('memory_read', { scope: 'global' })).content[0].text, /testing.md/)
      enabled = false
      await session.reload()
      assert.equal(session.getAllTools().some(tool => tool.name.startsWith('memory_')), false, 'disabled tools are not registered or discoverable')
      assert.equal(session.getActiveToolNames().some(name => name.startsWith('memory_')), false)
      const disabledPatch = (await prepare())!
      assert.equal(disabledPatch.memory, null, 'disabling removes the old guidance through the SDK patch')
      assert.equal(disabledPatch.pig_servers, null, 'disabling removes the memory server advertisement')
      record(disabledPatch)
      assert.equal(await prepare(), undefined, 'disabled memory adds no prompt sections on later runs')
      enabled = true
      await session.reload()
      assert.deepEqual(session.getAllTools().filter(tool => tool.name.startsWith('memory_')).map(tool => tool.name).sort(), ['memory_add', 'memory_delete', 'memory_edit', 'memory_read'])
      const enabledPatch = (await prepare())!
      assert.equal(enabledPatch.memory, baseline.memory)
      assert.match(enabledPatch.pig_servers!, /- memory \(tool_search\)/)
    } finally { session.dispose() }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

if (process.argv.includes('--fixture')) await fixture()
else test('file memory is tool-only, scoped and cancellable; guidance never injects indexes', async () => {
  const result = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 15000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
}, 20000)
