import { expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({ app: { isPackaged: false } }))
const { pruneOrphanSubagents } = await import('../src/main/subagents/cleanup')

test('startup removes only known orphans, preserving legacy, live and unreadable parent records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-subagent-cleanup-'))
  try {
    const live = join(root, 'parent.jsonl')
    await writeFile(live, '{}')
    for (const [id, records] of Object.entries({
      orphan: [{ parentSessionFile: join(root, 'gone.jsonl') }],
      legacy: [{}],
      mixed: [{}, { parentSessionFile: join(root, 'gone.jsonl') }],
      live: [{ parentSessionFile: live }],
      busy: [{ parentSessionFile: join(root, 'gone.jsonl') }],
      invalid: [{ parentSessionFile: 'relative.jsonl' }]
    })) {
      const directory = join(root, id)
      await mkdir(directory)
      await writeFile(join(directory, 'index.json'), JSON.stringify({ subagents: records }))
      await writeFile(join(directory, 'child.jsonl'), '{}')
    }
    await mkdir(join(root, 'corrupt'))
    await writeFile(join(root, 'corrupt', 'index.json'), '{')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await pruneOrphanSubagents(root, (id) => id === 'busy')
    } finally {
      warn.mockRestore()
    }
    expect((await readdir(root)).sort()).toEqual(['busy', 'corrupt', 'invalid', 'legacy', 'live', 'mixed', 'parent.jsonl'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
