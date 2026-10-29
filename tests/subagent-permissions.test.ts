import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-subagent-permissions-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, BrowserWindow: { getAllWindows: () => [] } }))
  const { AgentSession, ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
  mock.module('../src/main/pi/model-settings', () => ({ startModelRuntime: async () => runtime, availableModels: () => [] }))
  const { saveSessionPermission } = await import('../src/main/permissions/store')
  const { hasSessionGrant, forgetSessionGrants } = await import('../src/main/permissions/grants')
  const { restrictPermissionMode } = await import('../src/main/permissions/mode')
  const { createSdkRunner } = await import('../src/main/subagents/sdk-runner')
  const { setPluginScopes } = await import('../src/main/pi/plugins')
  await setPluginScopes('pi-review', [])
  await setPluginScopes('pi-web-access', [])
  for (const ceiling of ['read-only', 'default', 'full-access'] as const) {
    for (const parent of ['read-only', 'default', 'full-access'] as const) {
      const expected = ['read-only', 'default', 'full-access'][Math.min(['read-only', 'default', 'full-access'].indexOf(ceiling), ['read-only', 'default', 'full-access'].indexOf(parent))]
      assert.equal(restrictPermissionMode(ceiling, parent), expected)
    }
  }
  const output = join(root, 'executed')
  const command = `printf child > '${output}'`
  let releaseAnswer!: (answer: string) => void
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  let options: string[] = []
  let asked = 0
  const ui = { select: async (_title: string, choices: string[]) => {
    asked++
    options = choices
    enter()
    return new Promise<string>(resolve => { releaseAnswer = resolve })
  } }
  const originalPrompt = AgentSession.prototype.prompt
  AgentSession.prototype.prompt = async function () {
    const signal = new AbortController().signal
    const ctx = this.extensionRunner.createToolContext('probe', signal)
    assert.equal(ctx.hasUI, false, 'ordinary subagent extension UI remains disabled')
    const bash = this.extensionRunner.getToolDefinition('bash')!
    await saveSessionPermission('parent', 'read-only')
    await assert.rejects(bash.execute('readonly', { command, unsandboxed: true, reason: 'test' }, signal, undefined, ctx), /Read-only/)
    assert.equal(asked, 0)
    await saveSessionPermission('parent', 'default')
    const pending = bash.execute('pending', { command, unsandboxed: true, reason: 'test' }, signal, undefined, ctx)
    const outcome = pending.then(() => undefined, error => error)
    await entered
    await saveSessionPermission('parent', 'read-only')
    await saveSessionPermission('parent', 'default')
    assert.match(String(await outcome), /Permission mode changed/)
    releaseAnswer(options[1]!)
    await Promise.resolve()
    assert.equal(hasSessionGrant('parent', [`unsandboxed:${command}`]), false)
    assert.equal(existsSync(output), false)
    await saveSessionPermission('parent', 'full-access')
    const result = await bash.execute('full', { command, unsandboxed: true, reason: 'test' }, signal, undefined, ctx)
    assert.equal(result.isError, undefined)
    assert.equal(existsSync(output), true)
    await saveSessionPermission('parent', 'read-only')
    const write = this.extensionRunner.getToolDefinition('write')!
    await assert.rejects(write.execute('blocked', { path: join(root, 'blocked'), content: 'x' }, signal, undefined, ctx), /Read-only/)
    assert.equal(existsSync(join(root, 'blocked')), false)

    // Full-access writes already waiting in Pi's per-file queue must not run under a stale mode.
    await saveSessionPermission('parent', 'full-access')
    const queuedPath = join(root, 'queued')
    let hold!: () => void
    let enteredQueue!: () => void
    const locked = new Promise<void>(resolve => { enteredQueue = resolve })
    const unlock = new Promise<void>(resolve => { hold = resolve })
    const { withFileMutationQueue } = await import('@earendil-works/pi-coding-agent')
    const first = withFileMutationQueue(queuedPath, async () => { enteredQueue(); await unlock })
    await locked
    const queued = write.execute('queued', { path: queuedPath, content: 'old permission' }, signal, undefined, ctx)
    const queuedResult = queued.then(() => undefined, error => error)
    await new Promise(resolve => setTimeout(resolve, 0))
    await saveSessionPermission('parent', 'read-only')
    await saveSessionPermission('parent', 'full-access')
    hold()
    await first
    assert.match(String(await queuedResult), /aborted|Permission mode changed/i)
    assert.equal(existsSync(queuedPath), false)

    const started = join(root, 'started')
    const finished = join(root, 'finished')
    const running = bash.execute('running', { command: `printf started > '${started}'; sleep 0.3; printf done > '${finished}'` }, signal, undefined, ctx)
    const deadline = Date.now() + 5000
    while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(existsSync(started), true)
    await saveSessionPermission('parent', 'read-only')
    assert.equal((await running).isError, undefined)
    assert.equal(existsSync(finished), true, 'a shell already spawned retains its original mode')
  }
  try {
    await saveSessionPermission('parent', 'full-access')
    const runner = createSdkRunner(spec => {
      assert.equal(spec.id, 'abcd1234')
      assert.equal(spec.title, 'Child')
      return ui
    })
    const child = await runner.start({ id: 'abcd1234', title: 'Child', parentSessionId: 'parent', cwd: root, prompt: 'test', sessionDir: join(root, 'children') }, () => {})
    assert.deepEqual(await child.done, {})
  } finally {
    AgentSession.prototype.prompt = originalPrompt
    forgetSessionGrants('parent')
    const { shutdownSandbox } = await import('../src/main/sandbox/service')
    await shutdownSandbox()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('subagent approvals forward while effective permissions follow the parent without widening beyond launch', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 20_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally { clearTimeout(timeout) }
}, 25_000)
