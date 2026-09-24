import { test, expect } from 'bun:test'
import type { ProjectGroup } from '../src/shared/api'
import { compareGroupsByLatestSession } from '../src/shared/session-order'

function group(cwd: string, modified?: string): ProjectGroup {
  return {
    cwd,
    name: cwd,
    sessions: modified ? [{ id: cwd, path: cwd, cwd, created: '', modified, firstMessage: '', size: 1 }] : []
  }
}

test('groups sort by newest session, then cwd when activity ties', () => {
  const older = group('/z', '2026-01-01T00:00:00.000Z')
  const newer = group('/m', '2026-01-02T00:00:00.000Z')
  const tied = group('/a', '2026-01-02T00:00:00.000Z')
  const empty = group('/empty')
  expect([older, empty, newer, tied].sort(compareGroupsByLatestSession).map((item) => item.cwd))
    .toEqual(['/a', '/m', '/z', '/empty'])
})
