/** A README's links and images are relative to the file, not to the app's own URL. */
import { expect, test } from 'bun:test'
import { headingSlug, markdownImageSrc, markdownTarget } from '../src/renderer/src/components/files/markdown-links'
import { parseWorktreeFileUrl, worktreeFileUrl } from '../src/shared/worktree-files'

test('links resolve against the file directory and stay inside the worktree', () => {
  const file = 'docs/README.md'
  expect(markdownTarget(file, '#install')).toEqual({ kind: 'anchor', slug: 'install' })
  expect(markdownTarget(file, './guide.md')).toEqual({ kind: 'file', path: 'docs/guide.md', slug: null })
  expect(markdownTarget(file, '../src/a%20b.ts#L3')).toEqual({ kind: 'file', path: 'src/a b.ts', slug: 'L3' })
  expect(markdownTarget(file, '/CHANGELOG.md?plain=1')).toEqual({ kind: 'file', path: 'CHANGELOG.md', slug: null })
  expect(markdownTarget(file, '?plain=1#usage')).toEqual({ kind: 'anchor', slug: 'usage' })
  expect(markdownTarget(file, 'https://example.com')).toEqual({ kind: 'external' })
  expect(markdownTarget(file, 'MAILTO:a@b.c')).toEqual({ kind: 'external' })
  for (const href of ['../../outside.md', 'javascript:alert(1)', 'file:///etc/hosts', '//host/x', 'bad%E0.md', '..']) {
    expect(markdownTarget(file, href)).toEqual({ kind: 'blocked' })
  }
})

test('worktree images load through the pig-file scheme; remote and inline images load as written', () => {
  expect(markdownImageSrc('/repo', 'docs/README.md', 'img/logo.png')).toBe(worktreeFileUrl('/repo', 'docs/img/logo.png'))
  expect(markdownImageSrc('/repo', 'README.md', 'https://x.test/a.png')).toBe('https://x.test/a.png')
  expect(markdownImageSrc('/repo', 'README.md', 'data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==')
  expect(markdownImageSrc('/repo', 'README.md', '../escape.png')).toBeUndefined()
  expect(markdownImageSrc('/repo', 'README.md', 'file:///etc/a.png')).toBeUndefined()
  expect(markdownImageSrc('/repo', 'README.md', 'data:text/html,<b>x</b>')).toBeUndefined()
})

test('worktree file URLs round-trip and reject anything else', () => {
  const url = worktreeFileUrl('/Users/me/my repo', 'docs/a b/#1.png')
  expect(parseWorktreeFileUrl(url)).toEqual({ cwd: '/Users/me/my repo', path: 'docs/a b/#1.png' })
  for (const bad of ['pig-file://other/a/b', 'pig-image://worktree/a/b', 'pig-file://worktree/a', 'pig-file://worktree/a/b/c', 'pig-file://worktree/%E0/b', 'nope']) {
    expect(parseWorktreeFileUrl(bad)).toBeNull()
  }
})

test('heading anchors follow GitHub spelling', () => {
  expect(headingSlug(' Getting Started! ')).toBe('getting-started')
  expect(headingSlug('配置 & 使用')).toBe('配置--使用')
})
