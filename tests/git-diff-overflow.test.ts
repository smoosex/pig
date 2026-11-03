import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { GitExecError } from '../src/main/git/exec'
import { runSelf } from './helpers/subprocess.ts'

const first = `diff --git a/first.txt b/first.txt
index 1111111..2222222 100644
--- a/first.txt
+++ b/first.txt
@@ -1 +1 @@
-old
+new
`
const second = `diff --git a/second.txt b/second.txt
index 1111111..2222222 100644
--- a/second.txt
+++ b/second.txt
@@ -1 +1 @@
-old
+${'x'.repeat(9 * 1024 * 1024)}
`

async function runFixture(): Promise<void> {
  mock.module('../src/main/git/run', () => ({
    runGit: async (_cwd: string, args: string[]) => {
      if (args.includes('--is-inside-work-tree')) return 'true\n'
      if (args.includes('--verify')) return 'HEAD\n'
      const stdout = first + second
      throw new GitExecError('stdout maxBuffer length exceeded', {
        name: 'Error',
        message: 'stdout maxBuffer length exceeded',
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        stdout,
        stderr: ''
      })
    }
  }))
  const { readWorktreePatch } = await import('../src/main/git/diff')
  const result = await readWorktreePatch('/repo', 'all')
  assert.equal(result.git, true)
  assert.equal(result.truncated, true)
  assert.equal(result.patch, first)
}

if (process.argv[2] === '--git-diff-overflow-fixture') {
  await runFixture()
} else {
  test('a maxBuffer patch keeps complete files and reports truncation', async () => {
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--git-diff-overflow-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      timeoutMs: 25_000
    })
    assert.equal(code, 0, stderr || stdout)
  })
}
