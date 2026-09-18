/**
 * `parsePatchFiles` logs and recovers on its own, so `buildSections` can only reach its catch when the
 * parser throws outright — and what it must not do there is hand back cards that look like files without
 * changes. A mock is the only way to ask, and the mock is process-wide, so the check runs in a child
 * process of this file.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DiffFileEntry, WorktreeDiff, WorktreePatch } from '../src/shared/api'

async function runFixture(): Promise<void> {
  const real = await import('@pierre/diffs')
  mock.module('@pierre/diffs', () => ({
    ...real,
    getSingularPatch: () => {
      throw new Error('parse boom')
    }
  }))
  const { buildSections, materializeSection } = await import('../src/renderer/src/components/diff/sections')

  const entry: DiffFileEntry = { path: 'a.ts', status: 'modified', additions: 1, deletions: 1 }
  const diff: WorktreeDiff = { git: true, staged: [], unstaged: [entry], all: [entry] }
  const patch: WorktreePatch = { git: true, patch: 'diff --git a/a.ts b/a.ts\n', truncated: false }
  const sections = buildSections(diff, patch, 'all', {})
  assert.equal(sections[0]?.fileDiff, null, 'building the list does not invoke the parser')
  const section = materializeSection(sections[0]!)

  assert.equal(section.note, 'unparsed', 'a throw is not an empty diff')
  assert.equal(section.fileDiff, null)
  assert.equal(section.message, 'parse boom', 'and the card carries what the parser said')
}

if (process.argv[2] === '--diff-sections-parse-error-fixture') {
  await runFixture()
} else {
  test('a parser that throws is reported on the cards, not swallowed', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--diff-sections-parse-error-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
    }
  })
}
