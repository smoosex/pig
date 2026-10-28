/** Drives the permission extension against the real OS sandbox; macOS only, where srt needs no extra tools. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({ app: { isPackaged: false } }))
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionMode } from '../src/shared/permissions'

const darwin = process.platform === 'darwin'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-permissions-')))
const pigDir = join(root, 'pig')
const repo = join(root, 'repo')
const worktree = join(pigDir, 'worktrees', 'repo', 'one')
const previousPigDir = process.env.PIG_DIR
const previousTmp = process.env.TMPDIR
let server: Server
let port = 0

type Tool = { name: string; parameters: unknown; execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { text: string }[]; isError?: boolean; structuredContent?: { exit_code: number } }> }
type Handler = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>

async function load(mode: () => PermissionMode, shellPath?: string) {
  const { permissionsExtension } = await import('../src/main/permissions/extension')
  const tools = new Map<string, Tool>()
  const handlers = new Map<string, Handler>()
  let active: string[] | undefined
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getAllTools: () => [...tools.values()].map(({ name, parameters }) => ({ name, parameters })),
    getActiveTools: () => active ?? [...tools.keys()],
    setActiveTools: (names: string[]) => { active = names }
  }
  const settingsManager = { getShellPath: () => shellPath, getShellCommandPrefix: () => undefined, getDefaultTools: () => undefined }
  await permissionsExtension({ cwd: worktree, settingsManager: settingsManager as never, sessionId: 'session-1', mode })(pi as never)
  return { tools, handlers, pi }
}

// Approvals are selects of [once, session, deny]; no answer configured means the user denies.
type Answer = 'once' | 'session' | 'deny' | 'cancel'
function context(answers: { answer?: Answer; select?: (options: string[]) => string | undefined } = {}) {
  const asked: string[] = []
  return {
    asked,
    ctx: {
      cwd: worktree, hasUI: true,
      sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => undefined },
      ui: {
        select: async (title: string, options: string[]) => {
          asked.push(title)
          if (answers.select) return answers.select(options)
          const answer = answers.answer ?? 'deny'
          return answer === 'cancel' ? undefined : options[answer === 'once' ? 0 : answer === 'session' ? 1 : options.length - 1]
        }
      }
    }
  }
}

beforeAll(async () => {
  process.env.PIG_DIR = pigDir
  // The test root sits in the system temporary folder, which sandboxed commands may write; move that elsewhere.
  mkdirSync(join(root, 'tmp'))
  process.env.TMPDIR = join(root, 'tmp')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'])
  mkdirSync(join(pigDir, 'worktrees', 'repo'), { recursive: true })
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', worktree])
  writeFileSync(join(pigDir, 'mcp.json'), 'secret')
  server = createServer((_request, response) => response.end('local'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  server.close()
  const { shutdownSandbox } = await import('../src/main/sandbox/service')
  await shutdownSandbox()
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  if (previousTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmp
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(!darwin)('default mode sandboxes bash: workspace and repository writable, outside and secrets not', async () => {
  const { tools } = await load(() => 'default')
  const bash = tools.get('bash')!
  const { ctx } = context()
  const run = (command: string) => bash.execute('call', { command }, undefined, undefined, ctx)

  const commit = await run('echo a > f && git add f && git -c user.email=a@b -c user.name=a commit -qm work && git log --oneline | wc -l')
  expect(commit.isError).toBeUndefined()
  expect(commit.content[0]!.text.trim()).toBe('2')
  const outside = join(homedir(), `pig-sandbox-test-${process.pid}`)
  const refused = await run(`echo x > ${outside}`)
  expect(refused.isError).toBe(true)
  // A refusal tells the model how to ask rather than leaving it to work around the sandbox.
  expect(refused.content[0]!.text).toContain('write/edit')
  expect(refused.content[0]!.text).toContain('unsandboxed: true')
  expect(existsSync(outside)).toBe(false)
  const secret = await run(`cat ${join(pigDir, 'mcp.json')}`)
  expect(secret.isError).toBe(true)
  expect(secret.content[0]!.text).not.toContain('secret')
  expect((await run(`echo hook > '${join(repo, '.git', 'hooks', 'pre-commit')}'`)).isError).toBe(true)
  expect((await run(`echo config > '${join(repo, '.git', 'config')}'`)).isError).toBe(true)
  const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
  const worktreeConfig = join(gitDir, 'config.worktree')
  expect((await run(`printf '[fixture]\\nprobe = changed\\n' > '${worktreeConfig}'`)).isError).toBe(true)
  expect(existsSync(worktreeConfig)).toBe(false)
  expect((await run(`curl -sS http://127.0.0.1:${port}/`)).content[0]!.text).toContain('local')
})

test.skipIf(!darwin)('a refused host is reported after the command and can be allowed for the project', async () => {
  const { tools } = await load(() => 'default')
  const { ctx, asked } = context({ select: (options) => options[1] })
  const result = await tools.get('bash')!.execute('call', { command: 'curl -sS -o /dev/null https://example.com/' }, undefined, undefined, ctx)
  expect(result.isError).toBe(true)
  expect(result.content[0]!.text).toContain('deny network-outbound example.com:443')
  expect(result.content[0]!.text).toContain('The user allowed example.com')
  expect(asked).toHaveLength(1)
  const saved = JSON.parse(readFileSync(join(pigDir, 'permissions.json'), 'utf8'))
  expect(saved.projects[join(repo, '.git')].domains).toEqual(['example.com'])
})

test.skipIf(!darwin)('read-only keeps the workspace unwritable; unsandboxed runs need approval and a reason', async () => {
  let mode: PermissionMode = 'read-only'
  const { tools } = await load(() => mode)
  const bash = tools.get('bash')!
  const refused = context()
  const readOnlyWrite = await bash.execute('call', { command: 'echo x > ro.txt' }, undefined, undefined, refused.ctx)
  expect(readOnlyWrite.isError).toBe(true)
  expect(readOnlyWrite.content[0]!.text).toContain('allows no escalation')
  expect(readOnlyWrite.content[0]!.text).not.toContain('unsandboxed: true')
  expect(existsSync(join(worktree, 'ro.txt'))).toBe(false)
  const network = await bash.execute('call', { command: `curl --max-time 2 -sS http://127.0.0.1:${port}/` }, undefined, undefined, refused.ctx)
  expect(network.isError).toBe(true)
  const registry = await bash.execute('call', { command: 'curl --max-time 2 -sS https://registry.npmjs.org/' }, undefined, undefined, refused.ctx)
  expect(registry.isError).toBe(true)
  expect(refused.asked).toHaveLength(0)
  await expect(bash.execute('call', { command: 'true', unsandboxed: true, reason: 'x' }, undefined, undefined, refused.ctx)).rejects.toThrow(/Read-only/)

  mode = 'default'
  await expect(bash.execute('call', { command: 'true', unsandboxed: true }, undefined, undefined, refused.ctx)).rejects.toThrow(/reason/)
  await expect(bash.execute('call', { command: 'true', unsandboxed: true, reason: 'x' }, undefined, undefined, refused.ctx)).rejects.toThrow(/did not allow/)
  const outside = join(root, 'escaped.txt')
  const approved = context({ answer: 'once' })
  await bash.execute('call', { command: `echo x > ${outside}`, unsandboxed: true, reason: 'writes outside' }, undefined, undefined, approved.ctx)
  expect(existsSync(outside)).toBe(true)
})

test.skipIf(!darwin)('file tools execute in the sandbox, ask for external paths and refuse without UI', async () => {
  const { tools } = await load(() => 'default')
  const call = (name: string, path: string, answers = {}) => tools.get(name)!.execute('file', { path, content: 'file content' }, undefined, undefined, context(answers).ctx)
  await call('write', 'src/new.ts')
  expect(readFileSync(join(worktree, 'src/new.ts'), 'utf8')).toBe('file content')
  await Promise.all([
    tools.get('edit')!.execute('edit-1', { path: 'src/new.ts', edits: [{ oldText: 'file', newText: 'second' }] }, undefined, undefined, context().ctx),
    tools.get('edit')!.execute('edit-2', { path: 'src/new.ts', edits: [{ oldText: 'content', newText: 'third' }] }, undefined, undefined, context().ctx)
  ])
  expect(readFileSync(join(worktree, 'src/new.ts'), 'utf8')).toBe('second third')
  await expect(call('write', join(root, 'elsewhere.txt'))).rejects.toThrow(/did not allow/)
  await call('write', join(root, 'elsewhere.txt'), { answer: 'once' as Answer })
  expect(readFileSync(join(root, 'elsewhere.txt'), 'utf8')).toBe('file content')
  await expect(call('read', join(pigDir, 'mcp.json'))).rejects.toThrow(/did not allow/)
  expect((await call('read', join(pigDir, 'mcp.json'), { answer: 'once' as Answer })).content[0]!.text).toBe('secret')
  await expect(call('read', '~/.ssh/id_ed25519')).rejects.toThrow(/did not allow/)
  const noUi = { ...context({ answer: 'once' }).ctx, hasUI: false }
  await expect(tools.get('read')!.execute('file', { path: join(pigDir, 'mcp.json') }, undefined, undefined, noUi)).rejects.toThrow(/cannot ask the user/)
  await expect(call('write', join(root, 'cancelled.txt'), { answer: 'cancel' as Answer })).rejects.toThrow(/cancelled/)
})

test.skipIf(!darwin)('allowing for the session covers the same path and access only, until the session ends', async () => {
  const { tools } = await load(() => 'default')
  const run = (name: string, path: string, answer?: Answer) => {
    const { ctx, asked } = context({ answer })
    return tools.get(name)!.execute('file', { path, content: 'file content' }, undefined, undefined, ctx).then(() => asked)
  }
  const target = join(root, 'session-grant.txt')
  expect(await run('write', target, 'session')).toHaveLength(1)
  // Same path and access: no new question; a write grant also covers reading that path.
  expect(await run('write', target)).toHaveLength(0)
  expect(await run('read', target)).toHaveLength(0)
  await expect(run('write', join(root, 'other-grant.txt'))).rejects.toThrow(/did not allow/)
  const { forgetSessionGrants } = await import('../src/main/permissions/grants')
  forgetSessionGrants('session-1')
  await expect(run('write', target)).rejects.toThrow(/did not allow/)
})

test.skipIf(!darwin)('the actual file-open stays protected even if a path changes after a host check', async () => {
  const alias = join(worktree, 'switched-link')
  symlinkSync(join(pigDir, 'mcp.json'), alias)
  const { executeFileTool } = await import('../src/main/sandbox/file-tool')
  const { sessionWorkspace } = await import('../src/main/sandbox/service')
  await expect(executeFileTool('read', { path: alias }, {
    shell: '/bin/sh', mode: 'default', workspace: await sessionWorkspace(worktree), sessionId: 'session-1'
  })).rejects.toThrow(/Operation not permitted|permission denied|EACCES|EPERM/i)
})

test.skipIf(!darwin)('a project-configured shell can run only inside the sandbox', async () => {
  const marker = join(homedir(), `pig-untrusted-shell-${process.pid}`)
  const shell = join(worktree, 'custom-shell')
  writeFileSync(shell, `#!/bin/sh\necho escaped > '${marker}'\nexec /bin/sh "$@"\n`)
  chmodSync(shell, 0o755)
  try {
    const { tools } = await load(() => 'default', shell)
    await tools.get('bash')!.execute('shell', { command: 'true' }, undefined, undefined, context().ctx)
    expect(existsSync(marker)).toBe(false)
  } finally {
    rmSync(marker, { force: true })
  }
})

test('sandbox wrappers retain builtin defaults instead of enabling every file-search tool', async () => {
  const { handlers, pi } = await load(() => 'default')
  await handlers.get('session_start')!({}, context().ctx)
  expect(pi.getActiveTools().toSorted()).toEqual(['bash', 'edit', 'read', 'write'])
  const { isPermissionTool } = await import('../src/main/permissions/extension')
  expect(pi.getAllTools().every((tool) => isPermissionTool(tool.parameters as object))).toBe(true)
})

test('the permission section follows mode changes without returning a forced system prompt', async () => {
  let mode: PermissionMode = 'default'
  const { handlers } = await load(() => mode)
  const sections: Record<string, string> = {}
  const event = { systemPromptOptions: { sections } }
  expect(await handlers.get('before_agent_start')!(event, context().ctx)).toBeUndefined()
  expect(sections.permissions).toContain('Permission mode: default')
  expect(sections.permissions).toContain('use write/edit, which asks the user for that path only')
  expect(sections.permissions).toContain('retry that exact command with unsandboxed: true')
  const previous = sections.permissions
  await handlers.get('before_agent_start')!(event, context().ctx)
  expect(sections.permissions).toBe(previous)
  mode = 'read-only'
  await handlers.get('before_agent_start')!(event, context().ctx)
  expect(sections.permissions).toContain('No network')
  expect(sections.permissions).toContain('not covered by this first-stage sandbox')
})

test('a bash tool registered by another extension is refused outside full access', async () => {
  let mode: PermissionMode = 'default'
  const { handlers, pi } = await load(() => mode)
  pi.registerTool({ name: 'bash', parameters: {}, execute: async () => ({ content: [] }) })
  const event = { type: 'tool_call', toolName: 'bash', toolCallId: 'c', input: { command: 'true' } }
  expect((await handlers.get('tool_call')!(event, context().ctx))?.reason).toMatch(/replaced the bash tool/)
  mode = 'full-access'
  expect(await handlers.get('tool_call')!(event, context().ctx)).toBeUndefined()
})
