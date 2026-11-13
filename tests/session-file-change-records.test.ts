/** Real Codemode replay plus recorder lifecycle checks; no model or provider network calls. */
import { expect, mock, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { FILE_CHANGE_ENTRY, registerFileChangeRecorder } from '../src/main/pi/session-file-change-records'
import { runSelf } from './helpers/subprocess'

function recorder() {
  const handlers = new Map<string, ((event: never) => unknown)[]>()
  const records: { customType: string; data: unknown }[] = []
  registerFileChangeRecorder({
    on(name: string, handler: (event: never) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    appendEntry(customType: string, data: unknown) { records.push({ customType, data }) }
  } as unknown as ExtensionAPI)
  return {
    records,
    emit: (type: string, fields: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(type) ?? []) handler({ type, ...fields } as never)
    }
  }
}

if (!process.argv.includes('--nested-diff-fixture')) {
test('records finalized nested results with the actual input and outermost caller', () => {
  const { emit, records } = recorder()
  emit('tool_execution_start', { toolCallId: 'root', toolName: 'codemode' })
  emit('tool_execution_start', { toolCallId: 'wrapper', parentToolCallId: 'root', toolName: 'wrapper' })
  const edit = { toolCallId: 'edit', parentToolCallId: 'wrapper', toolName: 'edit' }
  emit('tool_execution_start', { ...edit, args: { path: 'original' } })
  emit('tool_result', { ...edit, input: { path: 'actual' }, details: { patch: 'before redaction' } })
  emit('tool_execution_end', { ...edit, isError: false, result: { details: { patch: 'final patch' } } })
  expect(records).toEqual([{ customType: FILE_CHANGE_ENTRY, data: {
    toolCallId: 'edit', parentToolCallId: 'root', tool: 'edit', path: 'actual', patch: 'final patch'
  } }])
})

test('does not record failures, direct results or late results after shutdown', () => {
  const { emit, records } = recorder()
  for (const [id, parent] of [['failed', 'root'], ['direct', undefined], ['late', 'root']] as const) {
    const call = { toolCallId: id, toolName: 'edit', parentToolCallId: parent }
    emit('tool_execution_start', call)
    emit('tool_result', { ...call, input: { path: 'file' } })
    if (id === 'late') emit('session_shutdown')
    emit('tool_execution_end', { ...call, isError: id === 'failed', result: { details: { patch: 'patch' } } })
  }
  expect(records).toEqual([])
})
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-nested-file-diff-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const sdk = await import('@earendil-works/pi-coding-agent')
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
  const { summarizeSessionFileChanges } = await import('../src/main/pi/session-file-changes')
  const runtime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  runtime.registerProvider('diff-fixture', {
    api: 'openai-completions', baseUrl: 'http://unused.invalid', apiKey: 'fixture-only',
    models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100000,
      maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
  })
  await runtime.setRuntimeApiKey('diff-fixture', 'fixture-only')
  mock.module('../src/main/pi/model-settings', () => ({ startModelRuntime: async () => runtime }))
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true })
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({
    defaultProvider: 'diff-fixture', defaultModel: 'model', cacheWarming: 'off', compaction: { enabled: false }
  }))
  const manager = sdk.SessionManager.create(root, join(root, 'sessions'))
  const { saveSessionPermission } = await import('../src/main/permissions/store')
  await saveSessionPermission(manager.getSessionId(), 'full-access')
  const { createSessionRuntime } = await import('../src/main/pi/session-runtime')
  const longLine = 'x'.repeat(9000)
  const written = 'written\n'.repeat(2000)
  await writeFile(join(root, 'a.txt'), `prefix\n${longLine}\nsuffix\n`)
  const code = [
    `await tools.edit(${JSON.stringify({ path: 'a.txt', edits: [{ oldText: longLine, newText: 'changed' }] })});`,
    `await tools.edit(${JSON.stringify({ path: 'a.txt', edits: [{ oldText: 'prefix', newText: 'updated' }] })});`,
    `try { await tools.edit({path: 'a.txt', edits: [{oldText: 'missing text', newText: 'bad'}]}); } catch {}`,
    `await tools.write(${JSON.stringify({ path: 'b.txt', content: written })});`,
    `throw new Error('Parent failed after successful writes');`
  ].join('\n')
  let requests = 0
  const stream = spyOn(runtime, 'streamSimple').mockImplementation((model, context) => {
    assert.equal(JSON.stringify(context.messages).includes(FILE_CHANGE_ENTRY), false, 'UI records never enter model context')
    const first = requests++ === 0
    const output = createAssistantMessageEventStream()
    output.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message: {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: first ? [{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: { code } }] : [{ type: 'text', text: 'done' }],
      stopReason: first ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    } })
    return output
  })
  const session = await createSessionRuntime(root, manager, [], undefined, { identity: false })
  try {
    await session.bindExtensions({ mode: 'print', onError: error => { throw new Error(error.error) } })
    await session.prompt('Change fixture files', { expandPromptTemplates: false })
    assert.equal(requests, 2)
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'updated\nchanged\nsuffix\n')
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), written)
    const entries = manager.getBranch()
    const records = entries.filter(entry => entry.type === 'custom' && entry.customType === FILE_CHANGE_ENTRY)
    assert.equal(records.length, 3, 'only successful nested file operations are recorded')
    const parent = entries.find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'parent')
    assert.ok(parent?.type === 'message' && parent.message.role === 'toolResult')
    assert.equal(parent.message.isError, true)
    assert.equal(parent.message.nestedCalls?.complete, false, 'large nested arguments exceed the SDK record limit')
    const summary = summarizeSessionFileChanges(entries, root)
    assert.equal(summary.files.length, 2)
    assert.equal(summary.files[0]?.operations.length, 2)
    assert.equal(summary.files[0]?.unknownOperations, 0)
    assert.equal(summary.files[0]?.added, 2)
    assert.equal(summary.files[0]?.removed, 2)
    assert.ok(summary.files[0]?.operations.every(operation => operation.patch))
    assert.equal(summary.files[1]?.added, 2000)
    assert.equal(summary.files[1]?.unknownOperations, 0)
    // Replay uses only JSONL, even if files have since changed or disappeared.
    await writeFile(join(root, 'a.txt'), 'unrelated subsequent change')
    await rm(join(root, 'b.txt'))
    const restored = sdk.SessionManager.open(manager.getSessionFile()!)
    assert.deepEqual(summarizeSessionFileChanges(restored.getBranch(), root), summary)
    const { indexSessionFile, readBranchEntries } = await import('../src/main/pi/session-jsonl')
    assert.deepEqual(summarizeSessionFileChanges(readBranchEntries(indexSessionFile(manager.getSessionFile()!)), root), summary)
    assert.equal(JSON.stringify(restored.buildSessionContext().messages).includes(FILE_CHANGE_ENTRY), false)
    const firstUser = entries.find(entry => entry.type === 'message' && entry.message.role === 'user')!
    restored.branch(firstUser.id)
    assert.equal(summarizeSessionFileChanges(restored.getBranch(), root).files.length, 0)
  } finally {
    session.dispose()
    stream.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--nested-diff-fixture')) await fixture()
else test('real Codemode persists file diffs for replay, oversized arguments and parent failure', async () => {
  const result = await runSelf(import.meta.path, ['--nested-diff-fixture'])
  assert.equal(result.exitCode, 0, result.stderr)
}, 30000)
