import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  applyFallbackPath,
  importShellEnvironment,
  mergeShellEnvironment,
  parseShellEnvironment,
  shellCandidates,
  type ShellProbe
} from '../src/main/shell-env'

const MARKER = '__PIG_SHELL_ENV__'

const probeOutput = (...entries: string[]): string =>
  `banner line that the rc printed\n${MARKER}\0${entries.join('\0')}\0`

test('parses the variables printed after an rc banner', () => {
  const entries = parseShellEnvironment(
    probeOutput(
      'EXA_API_KEY=secret',
      'PATH=/Users/me/.bun/bin:/usr/bin',
      'not-a-variable',
      '1BAD=x',
      'PWD=/Users/me',
      '_=/usr/bin/env',
      'SHLVL=2',
      'EMPTY=',
      'MULTI=line one\nline two'
    )
  )
  assert.deepEqual(entries, {
    EXA_API_KEY: 'secret',
    PATH: '/Users/me/.bun/bin:/usr/bin',
    EMPTY: '',
    MULTI: 'line one\nline two'
  })
})

test('ignores output that never reached the marker', () => {
  assert.deepEqual(parseShellEnvironment('zsh: command not found: env\n'), {})
})

test('keeps the launch environment and adds only missing variables', () => {
  const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/Users/me', LANG: 'en_US.UTF-8' }
  const result = mergeShellEnvironment(target, {
    PATH: '/Users/me/.bun/bin:/usr/bin',
    HOME: '/Users/me',
    EXA_API_KEY: 'secret'
  })
  assert.equal(target.PATH, '/Users/me/.bun/bin:/usr/bin:/bin')
  assert.equal(target.EXA_API_KEY, 'secret')
  assert.equal(target.HOME, '/Users/me')
  assert.equal(target.LANG, 'en_US.UTF-8')
  assert.deepEqual(result, { imported: 1, pathEntries: 2 })
})

test('keeps app-only PATH entries after the shell ones', () => {
  const target: NodeJS.ProcessEnv = { PATH: '/app/only:/bin' }
  mergeShellEnvironment(target, { PATH: '/Users/me/.bun/bin:/bin' })
  assert.equal(target.PATH, '/Users/me/.bun/bin:/bin:/app/only')
})

test('an existing PATH is left alone when the probe found none', () => {
  const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
  assert.deepEqual(mergeShellEnvironment(target, { EXA_API_KEY: 'secret' }), { imported: 1, pathEntries: 0 })
  assert.equal(target.PATH, '/usr/bin:/bin')
})

test('the fallback path adds the usual tool directories once', () => {
  const target: NodeJS.ProcessEnv = { HOME: '/Users/me', PATH: '/opt/homebrew/bin:/usr/bin' }
  assert.equal(applyFallbackPath(target), 6)
  assert.equal(
    target.PATH,
    '/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/Users/me/.local/bin:/Users/me/.bun/bin:/Users/me/.cargo/bin:/opt/homebrew/bin:/usr/bin'
  )
  assert.equal(applyFallbackPath(target), 0)
})

test('the probe runs the user shell with a minimal environment', async () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  let probeEnv: NodeJS.ProcessEnv | undefined
  try {
    await importShellEnvironment({
      shell: '/bin/zsh',
      probe: async (_shell, _args, env) => {
        probeEnv = env
        return probeOutput('PIG_SHELL_ENV_TEST_KEY=unused')
      }
    })
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = previous
    delete process.env.PIG_SHELL_ENV_TEST_KEY
  }
  assert.equal(probeEnv?.SHELL, '/bin/zsh')
  assert.equal(probeEnv?.TERM, 'xterm-256color')
  assert.equal(probeEnv?.APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP, '1')
  assert.equal(probeEnv?.GIT_TERMINAL_PROMPT, '0')
  assert.equal(probeEnv?.HOME, process.env.HOME)
  assert.equal(probeEnv?.PATH, undefined, 'the app PATH is not passed to the probe')
  assert.equal(probeEnv?.ELECTRON_RUN_AS_NODE, undefined, 'app switches do not leak into the user rc')
})

test('a timeout stops trying other shells and falls back', async () => {
  const previousShell = process.env.SHELL
  const previousPath = process.env.PATH
  delete process.env.SHELL
  process.env.PATH = '/usr/bin:/bin'
  const tried: string[] = []
  try {
    const result = await importShellEnvironment({
      probe: async (shell) => {
        tried.push(shell)
        throw Object.assign(new Error(`Command failed: ${shell} -ilc`), { killed: true, signal: 'SIGKILL' })
      }
    })
    assert.deepEqual(tried, ['/bin/zsh'], 'a hung rc is not retried through bash and sh')
    assert.equal(result.imported, 0)
    assert.ok(result.pathEntries > 0, 'the fallback PATH stands in')
  } finally {
    if (previousShell === undefined) delete process.env.SHELL
    else process.env.SHELL = previousShell
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

test('a shell that answers without a PATH is a failure', async () => {
  const previousPath = process.env.PATH
  const previousKey = process.env.PIG_SHELL_ENV_TEST_KEY
  try {
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.PIG_SHELL_ENV_TEST_KEY
    const result = await importShellEnvironment({
      shell: '/bin/zsh',
      probe: async () => probeOutput('PIG_SHELL_ENV_TEST_KEY=must-not-import')
    })
    assert.equal(result.imported, 0, 'the partial answer is not imported')
    assert.equal(process.env.PIG_SHELL_ENV_TEST_KEY, undefined)
    assert.ok(result.pathEntries > 0, 'the fallback PATH stands in')
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousKey === undefined) delete process.env.PIG_SHELL_ENV_TEST_KEY
    else process.env.PIG_SHELL_ENV_TEST_KEY = previousKey
  }
})

test('imports into process.env and survives a failing probe', async () => {
  const probeOnlyKeys = ['SHELL', 'TERM', 'GIT_TERMINAL_PROMPT', 'APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP'] as const
  const previous = new Map(
    ['PATH', 'PIG_SHELL_ENV_TEST_KEY', ...probeOnlyKeys].map((key) => [key, process.env[key]])
  )
  try {
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.PIG_SHELL_ENV_TEST_KEY
    const probe: ShellProbe = async () =>
      probeOutput(
        'PIG_SHELL_ENV_TEST_KEY=from-shell',
        'PATH=/shell/bin:/usr/bin',
        'SHELL=/bin/zsh',
        'TERM=xterm-256color',
        'APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP=1',
        'GIT_TERMINAL_PROMPT=0'
      )
    const result = await importShellEnvironment({ shell: '/bin/zsh', probe })
    assert.equal(result.imported, 1)
    assert.equal(process.env.PIG_SHELL_ENV_TEST_KEY, 'from-shell')
    assert.match(process.env.PATH ?? '', /^\/shell\/bin:\/usr\/bin:/, 'the shell PATH comes first')
    for (const key of probeOnlyKeys) {
      assert.equal(process.env[key], previous.get(key), `${key} is not changed by the probe`)
    }

    process.env.PATH = '/usr/bin:/bin'
    delete process.env.PIG_SHELL_ENV_TEST_KEY
    const failed = await importShellEnvironment({
      shell: '/bin/zsh',
      probe: async () => {
        throw new Error('probe timed out')
      }
    })
    assert.equal(failed.imported, 0)
    assert.ok(failed.pathEntries > 0, 'the fallback PATH stands in for the failed probe')
    assert.match(process.env.PATH ?? '', /^\/opt\/homebrew\/bin:.*\.bun\/bin:.*:\/usr\/bin:\/bin$/)
    assert.equal(process.env.PIG_SHELL_ENV_TEST_KEY, undefined)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('falls back to another shell when one returns nothing', async () => {
  const tried: string[] = []
  const previousPath = process.env.PATH
  const previousKey = process.env.PIG_SHELL_ENV_TEST_KEY
  const previousShell = process.env.SHELL
  delete process.env.SHELL
  delete process.env.PIG_SHELL_ENV_TEST_KEY
  try {
    const result = await importShellEnvironment({
      probe: async (shell) => {
        tried.push(shell)
        return shell === '/bin/bash'
          ? probeOutput('PATH=/bash/bin:/usr/bin', 'PIG_SHELL_ENV_TEST_KEY=from-bash')
          : 'zsh: no such thing\n'
      }
    })
    assert.deepEqual(tried, ['/bin/zsh', '/bin/bash'])
    assert.equal(result.imported, 1)
    assert.equal(process.env.PIG_SHELL_ENV_TEST_KEY, 'from-bash')
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousKey === undefined) delete process.env.PIG_SHELL_ENV_TEST_KEY
    else process.env.PIG_SHELL_ENV_TEST_KEY = previousKey
    if (previousShell === undefined) delete process.env.SHELL
    else process.env.SHELL = previousShell
  }
})

test('an explicitly requested shell is the only candidate', () => {
  assert.deepEqual(shellCandidates('/bin/dash'), ['/bin/dash'])
  const previousShell = process.env.SHELL
  try {
    delete process.env.SHELL
    assert.equal(shellCandidates()[0], '/bin/zsh')
    process.env.SHELL = '/bin/bash'
    assert.equal(shellCandidates()[0], '/bin/bash')
  } finally {
    if (previousShell === undefined) delete process.env.SHELL
    else process.env.SHELL = previousShell
  }
})
