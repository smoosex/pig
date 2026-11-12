import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-missing-project-fixture')) {
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spyOn } = await import('bun:test')
  const { DreamHistory } = await import('../src/main/features/memory/dream/history')
  const workspace = await import('../src/main/sandbox/workspace')
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pig-dream-origin-')))
  const old = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    const source = { id: 's', title: 'Old project', path: '/unused', cwd: join(root, 'removed-project') }
    const chat = { ...source, id: 'chat', cwd: join(root, 'chats', 'removed-chat') }
    const active = { ...source, id: 'active', cwd: join(root, 'active-project') }
    fs.mkdirSync(active.cwd)
    const history = new DreamHistory([source, chat, active])
    const context = await history.context(source)
    assert.equal(context.project, 'removed-project')
    assert.equal(context.originalCwd, source.cwd)
    assert.equal(context.projectIdentity, 'unresolved')
    assert.equal(context.projectId, undefined)
    assert.equal((await history.context(chat)).projectIdentity, 'chat')
    assert.deepEqual([...history.writableScopes()], ['global'])
    assert.throws(() => history.projectKey('a'.repeat(64)), /DREAM_SCOPE/)
    const resolved = await history.context(active)
    assert.equal(history.projectKey(resolved.projectId!), active.cwd)
    assert.equal(history.writableScopes().size, 2)
    assert.equal(fs.existsSync(source.cwd), false)
    const discovery = spyOn(workspace, 'sessionWorkspace').mockRejectedValue(Object.assign(new Error('Denied'), { code: 'EACCES' }))
    try { await assert.rejects(new DreamHistory([active]).context(active), { code: 'EACCES' }) }
    finally { discovery.mockRestore() }
  } finally {
    if (old === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = old
    fs.rmSync(root, { recursive: true, force: true })
  }
} else test('topic Dream preserves unresolved project origins and grants only reliable project IDs', async () => {
  const result = await runSelf(import.meta.path, ['--dream-missing-project-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
