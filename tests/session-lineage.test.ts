import { expect, test } from 'bun:test'
import { withSessionForks } from '../src/shared/session-lineage'

const HOME = '/sessions'

function session(id: string, modified: string, parentSession?: string) {
  return {
    id,
    path: `${HOME}/${id}.jsonl`,
    modified,
    ...(parentSession ? { parentSession: `${HOME}/${parentSession}.jsonl` } : {})
  }
}

const idsOf = (sessions: ReturnType<typeof session>[]) => withSessionForks(sessions).map((row) => row.id)

test('a fork whose parent is in the list is marked, and follows it', () => {
  const sessions = [session('parent', '2026-01-01T00:00:00Z'), session('fork', '2026-01-02T00:00:00Z', 'parent')]
  expect(idsOf(sessions)).toEqual(['parent', 'fork'])
  const rows = withSessionForks(sessions)
  expect(rows[0]!.forkedFrom).toBeUndefined()
  expect(rows[1]!.forkedFrom).toBe(`${HOME}/parent.jsonl`)
})

test('a fork family keeps the parent first and the forks under it', () => {
  const sessions = [
    session('parent', '2026-01-01T00:00:00Z'),
    session('first', '2026-01-02T00:00:00Z', 'parent'),
    session('second', '2026-01-03T00:00:00Z', 'parent')
  ]
  const rows = withSessionForks(sessions)
  // Siblings are newest-first, so the fresher fork leads among them.
  expect(rows.map((row) => row.id)).toEqual(['parent', 'second', 'first'])
  for (const row of rows.slice(1)) {
    expect(row.forkedFrom).toBe(`${HOME}/parent.jsonl`)
  }
})

test('a fork chain is marked at every level', () => {
  const sessions = [
    session('root', '2026-01-01T00:00:00Z'),
    session('mid', '2026-01-02T00:00:00Z', 'root'),
    session('leaf', '2026-01-03T00:00:00Z', 'mid')
  ]
  expect(idsOf(sessions)).toEqual(['root', 'mid', 'leaf'])
  expect(withSessionForks(sessions).map((row) => row.forkedFrom)).toEqual([
    undefined,
    `${HOME}/root.jsonl`,
    `${HOME}/mid.jsonl`
  ])
})

test('a subtree leads with the newest activity anywhere inside it', () => {
  const older = session('older', '2026-01-01T00:00:00Z')
  const parent = session('parent', '2026-01-02T00:00:00Z')
  const fresh = session('fresh', '2026-01-05T00:00:00Z', 'parent')
  const newer = session('newer', '2026-01-03T00:00:00Z')
  // Newest first, the listing's own order.
  expect(idsOf([fresh, newer, parent, older])).toEqual(['parent', 'fresh', 'newer', 'older'])
})

test('order: input keeps the arrangement and only pulls children under their parents', () => {
  const parent = session('parent', '2026-01-01T00:00:00Z')
  const other = session('other', '2026-01-03T00:00:00Z')
  const fork = session('fork', '2026-01-02T00:00:00Z', 'parent')
  expect(withSessionForks([other, parent, fork], { order: 'input' }).map((row) => row.id)).toEqual([
    'other',
    'parent',
    'fork'
  ])
})

test('a parent outside the listing leaves its fork unmarked', () => {
  const rows = withSessionForks([session('fork', '2026-01-02T00:00:00Z', 'gone')])
  expect(rows.map((row) => row.id)).toEqual(['fork'])
  expect(rows[0]!.forkedFrom).toBeUndefined()
})

test('a self-naming header cannot swallow its own row', () => {
  const sessions = [session('self', '2026-01-01T00:00:00Z', 'self'), session('b', '2026-01-02T00:00:00Z', 'self')]
  expect(idsOf(sessions)).toEqual(['self', 'b'])
  expect(withSessionForks(sessions).map((row) => row.forkedFrom)).toEqual([undefined, `${HOME}/self.jsonl`])
})
