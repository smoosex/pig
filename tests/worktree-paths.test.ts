/**
 * Where a path ends up when the row above it is renamed.
 *
 * This is the one piece of a rename that is not about the row the reader pointed at: renaming a folder
 * moves everything inside it, and every path that is keyed by the old spelling — a document's key, a file
 * tab's id, the level a refresh reads — has to land on the new one. A prefix matched one character too
 * loosely is what makes this worth pinning: `src` must not claim `src2/main.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { isUnder, renamedPath } from '../src/renderer/src/lib/worktree-paths'

describe('renamedPath', () => {
  test('moves the row itself', () => {
    expect(renamedPath('src/main.ts', 'src/main.ts', 'src/entry.ts')).toBe('src/entry.ts')
  })

  test('moves everything under a renamed folder', () => {
    expect(renamedPath('src/main.ts', 'src', 'source')).toBe('source/main.ts')
    expect(renamedPath('src/deep/leaf.ts', 'src', 'source')).toBe('source/deep/leaf.ts')
    expect(renamedPath('src', 'src', 'source')).toBe('source')
  })

  test('leaves a path the rename does not touch', () => {
    expect(renamedPath('other/main.ts', 'src', 'source')).toBeNull()
    expect(renamedPath('readme.md', 'src/main.ts', 'src/entry.ts')).toBeNull()
  })

  test('does not mistake a sibling sharing the prefix for something inside', () => {
    expect(renamedPath('src2/main.ts', 'src', 'source')).toBeNull()
    expect(renamedPath('src-old/main.ts', 'src', 'source')).toBeNull()
  })

  test('a rename to a deeper level carries the subtree along', () => {
    expect(renamedPath('src/deep/leaf.ts', 'src', 'a/b')).toBe('a/b/deep/leaf.ts')
  })
})

describe('isUnder', () => {
  test('counts a directory as holding itself but not its own name', () => {
    expect(isUnder('src', 'src')).toBe(false)
    expect(isUnder('src/main.ts', 'src')).toBe(true)
    expect(isUnder('src2/main.ts', 'src')).toBe(false)
  })
})
