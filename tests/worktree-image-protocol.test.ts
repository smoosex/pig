/**
 * The markdown preview's image scheme reads files a renderer names, so it has to refuse what a file
 * tab refuses: a directory nobody opened, a path or link leading out of the worktree, and anything
 * that is not an image.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function runFixture(): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pig-file-')))
  const root = join(base, 'repo')
  const outside = join(base, 'outside')
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(root, 'docs', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(root, 'notes.txt'), 'secret')
  await writeFile(join(outside, 'leak.png'), 'leak')
  await symlink(join(outside, 'leak.png'), join(root, 'link.png'))
  await symlink(outside, join(root, 'out'))
  mock.module('../src/main/worktree-access', () => ({
    openedWorktree: async (cwd: unknown) => (cwd === root ? root : null)
  }))
  const { worktreeImageResponse } = await import('../src/main/files/image')
  const { worktreeFileUrl } = await import('../src/shared/worktree-files')
  try {
    const served = await worktreeImageResponse(worktreeFileUrl(root, 'docs/logo.png'))
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual([...new Uint8Array(await served.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])
    for (const [cwd, path, why] of [
      [root, 'notes.txt', 'not an image'],
      [root, '../outside/leak.png', 'a path out of the worktree'],
      [root, 'link.png', 'a link at the last segment'],
      [root, 'out/leak.png', 'a linked directory leading out'],
      [root, 'docs/missing.png', 'a missing file'],
      [outside, 'leak.png', 'a directory nobody opened']
    ]) {
      assert.equal((await worktreeImageResponse(worktreeFileUrl(cwd, path))).status, 404, why)
    }
    assert.equal((await worktreeImageResponse('pig-file://worktree/%E0/x.png')).status, 404)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

// The worktree-access mock is process-wide, so the fixture runs in its own process.
if (process.argv[2] === '--worktree-image-fixture') {
  await runFixture()
} else {
  test('pig-file serves worktree images and refuses everything else', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--worktree-image-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stdout + stderr)
  })
}
