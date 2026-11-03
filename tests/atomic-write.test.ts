import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../src/main/atomic-write'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pig-atomic-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
})

test('atomic write lands the document with mode 0600 and no scratch file', async () => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  await writeFileAtomic(file, '{"version":1}\n')
  assert.equal(readFileSync(file, 'utf8'), '{"version":1}\n')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('a failed rename keeps the previous document and removes the scratch file', async () => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  await writeFileAtomic(file, 'first\n')
  const occupied = join(dir, 'occupied')
  mkdirSync(occupied)
  await assert.rejects(writeFileAtomic(occupied, 'second\n'))
  assert.equal(readFileSync(file, 'utf8'), 'first\n')
  assert.deepEqual(readdirSync(dir).sort(), ['occupied', 'state.json'])
})

test('concurrent writers leave one complete document, not a mixture', async () => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  const payloads = Array.from({ length: 8 }, (_, index) => `{"writer":${index},"pad":"${'x'.repeat(4096)}"}\n`)
  await Promise.all(payloads.map((body) => writeFileAtomic(file, body)))
  const written = readFileSync(file, 'utf8')
  assert.ok(payloads.includes(written), 'the file must be exactly one of the writes')
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('a missing parent directory is reported instead of created', async () => {
  const dir = scratch()
  await assert.rejects(writeFileAtomic(join(dir, 'missing', 'state.json'), 'x\n'), /ENOENT/)
  assert.deepEqual(readdirSync(dir), [])
})

test('overwriting an existing document leaves complete JSON behind', async () => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  writeFileSync(file, '{"version":1,"projects":[]}\n')
  await writeFileAtomic(file, JSON.stringify({ version: 1, projects: [{ cwd: '/repo', openedAt: 'now' }] }, null, 2))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).projects[0].cwd, '/repo')
})
