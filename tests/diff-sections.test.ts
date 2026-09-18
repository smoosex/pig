/**
 * `buildSections` is where a scope's file list meets the parsed patch, and the two do not always agree: git
 * lists paths the parser never hands back (it quotes and escapes `"` and `\` in names, the parser unescapes
 * the quotes but keeps the backslashes) and the parser recovers from bad input by logging rather than
 * throwing. A path in that gap used to render as 没有可显示的变更 — a blank card that looks like success —
 * so each reason a card has nothing to draw is pinned here.
 */
import { describe, expect, test } from 'bun:test'
import { buildSections, materializeSection } from '../src/renderer/src/components/diff/sections'
import type { DiffFileEntry, WorktreeDiff, WorktreePatch } from '../src/shared/api'

const PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
`

const MODE_ONLY = `diff --git a/mode.sh b/mode.sh
old mode 100644
new mode 100755
`

const BINARY = `diff --git a/blob.bin b/blob.bin
index 1111111..2222222 100644
Binary files a/blob.bin and b/blob.bin differ
`

/** What git really prints for a path holding a quote, escapes and all. */
const QUOTED = String.raw`diff --git "a/we\"ird.txt" "b/we\"ird.txt"
index 1111111..2222222 100644
--- "a/we\"ird.txt"
+++ "b/we\"ird.txt"
@@ -1,2 +1,2 @@
 one
-two
+three
`

function entry(
  path: string,
  status: DiffFileEntry['status'] = 'modified',
  additions: number | null = 1,
  deletions: number | null = 1
): DiffFileEntry {
  return { path, status, additions, deletions }
}

function diffOf(entries: DiffFileEntry[]): WorktreeDiff {
  return { git: true, staged: [], unstaged: entries, all: entries }
}

function patchOf(patch: string, truncated = false): WorktreePatch {
  return { git: true, patch, truncated }
}

describe('buildSections', () => {
  test('draws the file the parser handed back', () => {
    const sections = buildSections(diffOf([entry('a.ts')]), patchOf(PATCH), 'all', {})
    expect(sections[0]?.fileDiff).toBeNull()
    const section = materializeSection(sections[0]!)
    expect(section.note).toBeNull()
    expect(section.fileDiff?.name).toBe('a.ts')
  })

  test('calls a path the parser did not hand back unparsed, not empty', () => {
    const sections = buildSections(diffOf([entry('a.ts'), entry('b.ts')]), patchOf(PATCH), 'all', {})
    const section = materializeSection(sections[1]!)
    expect(section.note).toBe('unparsed')
    expect(section.fileDiff).toBeNull()
  })

  test('unparsed covers the escaped names git prints, not only a broken patch', () => {
    const sections = buildSections(diffOf([entry(String.raw`"we\"ird.txt"`)]), patchOf(QUOTED), 'all', {})
    expect(materializeSection(sections[0]!).note).toBe('unparsed')
  })

  test('keeps a change that only moves the mode as a diff', () => {
    const sections = buildSections(diffOf([entry('mode.sh', 'modified', 0, 0)]), patchOf(MODE_ONLY), 'all', {})
    const section = materializeSection(sections[0]!)
    expect(section.note).toBeNull()
    expect(section.fileDiff?.name).toBe('mode.sh')
  })

  test('reports a binary file instead of drawing its hunk-less block', () => {
    const sections = buildSections(diffOf([entry('blob.bin', 'modified', null, null)]), patchOf(BINARY), 'all', {})
    expect(sections[0]?.note).toBe('binary')
    expect(sections[0]?.fileDiff).toBeNull()
  })

  test('keeps tracked cards pending until their scope patch arrives', () => {
    const sections = buildSections(diffOf([entry('a.ts')]), undefined, 'all', {})
    expect(sections[0]).toMatchObject({ note: null, pending: true, fileDiff: null })
  })

  test('leaves an unread untracked file pending rather than binary', () => {
    const sections = buildSections(diffOf([entry('new.ts', 'untracked', null, null)]), patchOf(PATCH), 'all', {})
    expect(sections[0]?.pending).toBe(true)
    expect(sections[0]?.note).toBeNull()
  })

  test('reads a truncated patch as truncated, not as a parse problem', () => {
    const sections = buildSections(diffOf([entry('b.ts')]), patchOf(PATCH, true), 'all', {})
    expect(materializeSection(sections[0]!).note).toBe('truncated')
  })
})
