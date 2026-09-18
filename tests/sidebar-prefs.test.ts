/**
 * Sidebar preferences are one small file behind both sidebars, and every branch here used to end in
 * "return the defaults": a read that failed, and a file that would not parse. The first hides a real
 * failure, the second lets the next write overwrite a file it never understood. `sidebar-prefs` pulls in
 * electron through `pig-dir`, and the electron mock is process-wide, so this runs in a child process.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SidebarPrefs } from '../src/shared/api'

const defaults: SidebarPrefs = {
  projectsCollapsed: false,
  chatsCollapsed: false,
  split: 0.5,
  reviewOpen: false,
  reviewWidth: 320
}

async function runFixture(): Promise<void> {
  mock.module('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))
  const root = await mkdtemp(join(tmpdir(), 'pig-prefs-'))
  process.env.PIG_DIR = root
  const file = join(root, 'sidebar.json')
  const backup = `${file}.corrupt`
  const { loadSidebarPrefs, saveSidebarPrefs } = await import('../src/main/sidebar-prefs')

  try {
    assert.deepEqual(await loadSidebarPrefs(), defaults, 'a file that was never written is the defaults')
    assert.equal(await readFile(backup, 'utf8').then(() => true, () => false), false)

    const broken = '{"projectsCollapsed": true, "reviewOpen": '
    await writeFile(file, broken)
    assert.deepEqual(await loadSidebarPrefs(), defaults, 'a file that will not parse falls back')
    assert.equal(await readFile(backup, 'utf8'), broken, 'and is kept aside instead of being dropped')
    await writeFile(file, broken)
    await saveSidebarPrefs({ reviewOpen: true })
    assert.equal(await readFile(backup, 'utf8'), broken, 'the kept copy survives the next write')
    assert.deepEqual(
      JSON.parse(await readFile(file, 'utf8')),
      { version: 1, ...defaults, reviewOpen: true },
      'which writes the patch over defaults rather than over the unreadable file'
    )

    if (process.getuid?.() !== 0) {
      await writeFile(file, JSON.stringify({ reviewOpen: true, reviewWidth: 400 }))
      await chmod(file, 0o000)
      await assert.rejects(loadSidebarPrefs(), /EACCES/, 'a read that failed is reported, not defaulted')
      await chmod(file, 0o644)
      assert.equal((await loadSidebarPrefs()).reviewWidth, 400, 'and the file is still there to read')
      // Writing over an existing file needs the file to be writable, not the directory.
      await chmod(file, 0o444)
      await assert.rejects(saveSidebarPrefs({ reviewOpen: false }), /EACCES/, 'a write that failed is reported')
      await chmod(file, 0o644)
      assert.equal(
        JSON.parse(await readFile(file, 'utf8')).reviewOpen,
        true,
        'and nothing was written for the failed save'
      )
    }
  } finally {
    await chmod(root, 0o755).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--sidebar-prefs-fixture') {
  await runFixture()
} else {
  test('sidebar prefs report a failed read and keep a file they cannot parse', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--sidebar-prefs-fixture'], {
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
