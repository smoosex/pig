import { expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionMode } from '../src/shared/permissions'

const flag = '--sandbox-boundaries-fixture'
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function fixture() {
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const root = process.env.SANDBOX_FIXTURE_ROOT!
  const pig = process.env.PIG_DIR!
  const cwd = join(pig, 'worktrees', 'test', 'one')
  mkdirSync(cwd, { recursive: true })
  const auth = join(process.env.PI_CODING_AGENT_DIR!, 'auth.json')
  const models = join(process.env.PI_CODING_AGENT_DIR!, 'models.json')
  const npmrc = join(process.env.HOME!, '.npmrc')
  const gitCredentials = join(process.env.HOME!, '.git-credentials')
  const custom = process.env.NPM_CONFIG_USERCONFIG!
  symlinkSync(root, join(process.env.HOME!, '.cache'))
  for (const path of [auth, models, npmrc, gitCredentials, custom]) writeFileSync(path, 'fixture-only')
  const policy = join(pig, 'permissions.json')
  writeFileSync(policy, '{')
  const { sandboxCommand, ensureSandbox, shutdownSandbox, policyEnvironment, realTarget } = await import('../src/main/sandbox/service')
  try {
    await expect(ensureSandbox()).rejects.toThrow()
    await expect(ensureSandbox()).rejects.toThrow()
    writeFileSync(policy, JSON.stringify({ version: 1, defaultMode: 'default', domains: [], projects: {} }))
    expect(await ensureSandbox()).toEqual({ state: 'ready' })
    const original = readFileSync(policy, 'utf8')
    const run = async (mode: PermissionMode, command: string) => {
      const wrapped = await sandboxCommand(command, { mode, shell: '/bin/sh', workspace: { cwd: realTarget(cwd), gitCommonDir: null }, sessionId: 'fixture' })
      try {
        const child = Bun.spawn(['/bin/sh', '-c', wrapped.command], { cwd, stdout: 'pipe', stderr: 'pipe' })
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        return { code, stdout, stderr }
      } finally { wrapped.finish() }
    }
    for (const mode of ['default', 'read-only'] as const) {
      // PIG_DIR is inside /tmp, and its name must not be interpreted as an srt glob.
      expect((await run(mode, `printf changed > ${quote(policy)}`)).code).not.toBe(0)
      expect(readFileSync(policy, 'utf8')).toBe(original)
      for (const path of [auth, models, npmrc, gitCredentials, custom]) {
        const result = await run(mode, `cat ${quote(path)}`)
        expect(result.code).not.toBe(0)
        expect(result.stdout).not.toContain('fixture-only')
      }
      expect((await run(mode, `printf temporary > "$TMPDIR/fixture"; test -f "$TMPDIR/fixture"`)).code).toBe(0)
      expect((await run(mode, `printf bad > ${quote(join(root, 'unrelated'))}`)).code).not.toBe(0)
    }
    const localWrite = await run('default', 'printf valid > local-file')
    if (localWrite.code !== 0) throw new Error(`Workspace write failed: ${localWrite.stderr}`)
    expect((await run('read-only', 'printf invalid > local-file')).code).not.toBe(0)
    expect(readFileSync(join(cwd, 'local-file'), 'utf8')).toBe('valid')
    const scratch = policyEnvironment().temporary[0]
    expect(scratch.startsWith(`${pig}/`)).toBe(false)
  } finally { await shutdownSandbox() }
}

if (process.argv.includes(flag)) {
  await fixture()
} else {
  test.skipIf(process.platform !== 'darwin')('temporary Pig data, overridden credentials and literal path names stay protected; repaired policy retries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pig-sandbox-boundaries-'))
    const home = join(root, 'home')
    const agent = join(root, 'custom-agent')
    mkdirSync(home)
    mkdirSync(agent)
    const child = Bun.spawn([process.execPath, import.meta.filename, flag], {
      env: { ...process.env, HOME: home, PIG_DIR: join(root, 'pig[1]'), PI_CODING_AGENT_DIR: agent,
        NPM_CONFIG_USERCONFIG: join(root, 'custom-npmrc'), SANDBOX_FIXTURE_ROOT: root }, stdout: 'pipe', stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`Sandbox boundaries fixture exited ${code}: ${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      clearTimeout(timer)
      child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 25_000)
}
