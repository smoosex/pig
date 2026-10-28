import { expect, mock, test } from 'bun:test'

mock.module('electron', () => ({ app: { isPackaged: false } }))
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Outside tmpdir: srt deliberately allows temporary writes, which would mask an escaped probe.
test.skipIf(process.platform !== 'darwin')('search probes and execution stay sandboxed; managed bins retain the host SDK directory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-search-')))
  const cwd = join(root, 'workspace')
  const bin = join(root, 'bin')
  const agent = join(root, 'agent')
  const sentinel = join(homedir(), `.pig-search-escape-${process.pid}-${Date.now()}`)
  const oldPath = process.env.PATH
  const oldAgent = process.env.PI_CODING_AGENT_DIR
  const oldPig = process.env.PIG_DIR
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const realRg = Bun.which('rg')
  const realFd = Bun.which('fd')
  if (!realRg || !realFd) throw new Error('This sandbox regression requires installed rg and fd')
  for (const path of [cwd, bin, join(agent, 'bin')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(cwd, 'sample.txt'), 'needle\n')
  function fake(name: string, target: string, path = join(bin, name)) {
    writeFileSync(path, `#!/bin/sh\n(printf escaped > ${quote(sentinel)}) 2>/dev/null || :\nprintf '%s\\n' ${quote(name)} >> ${quote(join(cwd, 'ran'))}\nexec ${quote(target)} "$@"\n`)
    chmodSync(path, 0o755)
  }
  fake('rg', realRg)
  fake('fd', realFd)
  process.env.PATH = `${bin}:/usr/bin:/bin`
  process.env.PI_CODING_AGENT_DIR = agent
  process.env.PIG_DIR = join(root, 'pig')
  const { executeFileTool } = await import('../src/main/sandbox/file-tool')
  const { shutdownSandbox } = await import('../src/main/sandbox/service')
  const request = { shell: '/bin/sh', mode: 'default' as const, workspace: { cwd, gitCommonDir: null }, sessionId: 'search-regression' }
  try {
    expect((await executeFileTool('read', { path: 'sample.txt' }, request)).content[0]).toMatchObject({ text: 'needle\n' })
    await executeFileTool('ls', { path: '.' }, request)
    expect(existsSync(join(cwd, 'ran'))).toBe(false)
    const grep = await executeFileTool('grep', { pattern: 'needle', path: '.' }, request)
    expect(JSON.stringify(grep)).toContain('sample.txt')
    const find = await executeFileTool('find', { pattern: '*.txt', path: '.' }, request)
    expect(JSON.stringify(find)).toContain('sample.txt')
    expect(readFileSync(join(cwd, 'ran'), 'utf8')).toContain('rg')
    expect(readFileSync(join(cwd, 'ran'), 'utf8')).toContain('fd')
    expect(existsSync(sentinel)).toBe(false)
    // A managed binary is preferred even though PI_* was stripped from the child environment.
    fake('managed-rg', realRg, join(agent, 'bin', 'rg'))
    await executeFileTool('grep', { pattern: 'needle', path: 'sample.txt', runtime: { agentDir: '/untrusted' } }, request)
    expect(readFileSync(join(cwd, 'ran'), 'utf8')).toContain('managed-rg')
    expect(existsSync(sentinel)).toBe(false)
    rmSync(join(agent, 'bin', 'rg'))
    rmSync(join(bin, 'rg'))
    await expect(executeFileTool('grep', { pattern: 'needle', path: '.' }, request)).rejects.toThrow(/Install ripgrep\/fd/)
    expect(existsSync(join(agent, 'bin', 'rg'))).toBe(false)
  } finally {
    await shutdownSandbox()
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent
    if (oldPig === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = oldPig
    rmSync(sentinel, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
