/**
 * Local file references in assistant Markdown replies: parsing relative paths, absolute paths,
 * `file://` URIs, `~/` home paths, and line anchors, plus DOM verification of hover-card facts and
 * opening workspace files vs external OS files.
 */
import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  isChatPassthroughHref,
  matchOpenedWorkspaceFile,
  parseInlineCodeFileLink,
  parseMarkdownFileLink
} from '../src/shared/file-links'
import { runSelf } from './helpers/subprocess.ts'

if (process.argv[2] === '--markdown-file-links-dom') {
  await runDomFixture()
  process.exit(0)
}

describe('parseMarkdownFileLink', () => {
  const cwd = '/Users/smoose/Documents/小说/故人西来'

  test('resolves workspace-relative paths, percent-encoded names, and literal percent signs', () => {
    expect(parseMarkdownFileLink('正文/002-卷一-第二章-两口井.md', cwd)).toEqual({
      kind: 'file',
      path: '正文/002-卷一-第二章-两口井.md',
      relativeToCwd: true,
      line: null
    })
    expect(parseMarkdownFileLink('./src/main/window.ts#L67-L70', cwd)).toEqual({
      kind: 'file',
      path: 'src/main/window.ts',
      relativeToCwd: true,
      line: 67
    })
    expect(parseMarkdownFileLink('README.md:15:3', cwd)).toEqual({
      kind: 'file',
      path: 'README.md',
      relativeToCwd: true,
      line: 15
    })
    expect(parseMarkdownFileLink('进度50%完成%20稿.md', cwd)).toEqual({
      kind: 'file',
      path: '进度50%完成 稿.md',
      relativeToCwd: true,
      line: null
    })
    expect(parseMarkdownFileLink('../另一部小说/大纲.md', cwd)).toEqual({
      kind: 'file',
      path: '/Users/smoose/Documents/小说/另一部小说/大纲.md',
      relativeToCwd: false,
      line: null
    })
    expect(parseMarkdownFileLink('正文/002.md', null)).toEqual({ kind: 'blocked' })
  })

  test('parses file:// URIs, absolute paths, and ~/ home paths while blocking remote hosts and scripts', () => {
    const encoded =
      'file:///Users/smoose/Documents/%E5%B0%8F%E8%AF%B4/%E6%95%85%E4%BA%BA%E8%A5%BF%E6%9D%A5/%E6%AD%A3%E6%96%87/002-%E5%8D%B7%E4%B8%80-%E7%AC%AC%E4%BA%8C%E7%AB%A0-%E4%B8%A4%E5%8F%A3%E4%BA%95.md#L12'
    expect(parseMarkdownFileLink(encoded, cwd)).toEqual({
      kind: 'file',
      path: '/Users/smoose/Documents/小说/故人西来/正文/002-卷一-第二章-两口井.md',
      relativeToCwd: false,
      line: 12
    })
    expect(parseMarkdownFileLink('file:///C:/Users/me/notes.md:8', null)).toEqual({
      kind: 'file',
      path: 'C:/Users/me/notes.md',
      relativeToCwd: false,
      line: 8
    })
    expect(parseMarkdownFileLink('~/.pi/agent/models.json#L4', null)).toEqual({
      kind: 'file',
      path: '~/.pi/agent/models.json',
      relativeToCwd: false,
      line: 4
    })
    expect(parseMarkdownFileLink('https://example.com/docs', cwd)).toEqual({
      kind: 'external',
      href: 'https://example.com/docs'
    })
    expect(parseMarkdownFileLink('#section-2', cwd)).toEqual({
      kind: 'anchor',
      href: '#section-2'
    })
    for (const unsafe of [
      'javascript:alert(1)',
      'javascript:1',
      'data:text/html,<b>x</b>',
      'file://attacker/share/secret.txt',
      '//evil.example/a',
      '~/../../etc/passwd'
    ]) {
      expect(parseMarkdownFileLink(unsafe, cwd)).toEqual({ kind: 'blocked' })
    }
  })

  test('urlTransform passthrough allows only safe local href forms and matches deepest workspace root', () => {
    expect(isChatPassthroughHref('file:///Users/me/a.md')).toBe(true)
    expect(isChatPassthroughHref('C:/Users/me/a.md')).toBe(true)
    expect(isChatPassthroughHref('README.md:42')).toBe(true)
    expect(isChatPassthroughHref('javascript:alert(1)')).toBe(false)
    expect(isChatPassthroughHref('javascript:1')).toBe(false)
    expect(isChatPassthroughHref('data:image/png;base64,AA==')).toBe(false)

    expect(
      matchOpenedWorkspaceFile(
        '/repo/.worktrees/feat/src/index.ts',
        ['/repo'],
        [{ cwd: '/repo', worktrees: [{ cwd: '/repo/.worktrees/feat', missing: false }] }]
      )
    ).toEqual({
      cwd: '/repo/.worktrees/feat',
      relativePath: 'src/index.ts'
    })
  })
})

describe('parseInlineCodeFileLink', () => {
  const cwd = '/Users/smoose/pig_projects/对话转项目测试'

  test('recognizes inline-code local paths across absolute, ~/, relative, and :line forms', () => {
    expect(parseInlineCodeFileLink('/Users/smoose/pig_projects/对话转项目测试/红线啦啦啦.md', cwd)).toEqual({
      path: '/Users/smoose/pig_projects/对话转项目测试/红线啦啦啦.md',
      relativeToCwd: false,
      line: null
    })
    expect(parseInlineCodeFileLink('/Users/smoose/my folder/notes.txt', null)).toEqual({
      path: '/Users/smoose/my folder/notes.txt',
      relativeToCwd: false,
      line: null
    })
    expect(parseInlineCodeFileLink('红线啦啦啦.md', cwd)).toEqual({
      path: '红线啦啦啦.md',
      relativeToCwd: true,
      line: null
    })
    expect(parseInlineCodeFileLink('src/main/window.ts:67', cwd)).toEqual({
      path: 'src/main/window.ts',
      relativeToCwd: true,
      line: 67
    })
    expect(parseInlineCodeFileLink('~/.pi/agent/models.json', null)).toEqual({
      path: '~/.pi/agent/models.json',
      relativeToCwd: false,
      line: null
    })
    expect(parseInlineCodeFileLink('src/native/bridge.c', cwd)).toEqual({
      path: 'src/native/bridge.c',
      relativeToCwd: true,
      line: null
    })
    expect(parseInlineCodeFileLink('Dockerfile', cwd)).toEqual({
      path: 'Dockerfile',
      relativeToCwd: true,
      line: null
    })
    expect(parseInlineCodeFileLink('.env.local', cwd)).toEqual({
      path: '.env.local',
      relativeToCwd: true,
      line: null
    })
  })

  test('rejects API endpoints, shell commands, JS member expressions, package names, and framework names', () => {
    for (const nonFile of [
      '/models',
      '/v1/chat/completions',
      '/api/users.json',
      'bun run test',
      'env -u PIG_DIR bun run dev',
      '/usr/bin/env -u PIG_DIR',
      '--config.json',
      '@lobehub/streamdown',
      'origin/main',
      'bot/a-fdf418',
      'image/png',
      'window.api',
      'state.items',
      'process.env',
      'import.meta.env',
      'console.log',
      'Node.js',
      'Next.js',
      'v1.4.3',
      'a.c',
      'github.com',
      "import('./a.ts')"
    ]) {
      expect(parseInlineCodeFileLink(nonFile, cwd)).toBeNull()
    }
    expect(parseInlineCodeFileLink('红线啦啦啦.md', null)).toBeNull()
  })
})

async function runDomFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  const openedTabs: { cwd: string; path: string; preview?: boolean }[] = []
  const openedExternally: string[] = []
  const workspaceExternally: { cwd: string; path: string }[] = []

  const api = {
    fileMentionInfo: async (cwd: string, path: string) => {
      if (path === '正文') {
        return { kind: 'directory' as const, absolutePath: `${cwd}/正文`, modifiedAt: Date.now() - 60_000 }
      }
      return {
        kind: 'file' as const,
        absolutePath: `${cwd}/${path}`,
        modifiedAt: Date.now() - 60_000,
        lineCount: 369
      }
    },
    localFileMentionInfo: async (path: string) => ({
      kind: 'file' as const,
      absolutePath: path,
      modifiedAt: Date.now() - 60_000,
      lineCount: 18
    }),
    openFileExternally: async (cwd: string, path: string) => {
      workspaceExternally.push({ cwd, path })
    },
    openLocalFileExternally: async (path: string) => {
      openedExternally.push(path)
    },
    getSessionFileChanges: async () => ({
      leafId: 'leaf-1',
      files: [
        {
          path: '/Users/smoose/Documents/小说/故人西来/正文/002-卷一-第二章-两口井.md',
          relativePath: '正文/002-卷一-第二章-两口井.md',
          added: 371,
          removed: 2,
          unknownOperations: 0,
          operationCount: 1
        }
      ],
      turns: {}
    })
  }
  Object.defineProperty(globalThis, 'window', { value: Object.assign(globalThis.window, { api }), configurable: true })

  const React = await import('react')
  const { act, createElement } = React
  const { createRoot } = await import('react-dom/client')
  const { FileMentionChip, FileMentionProvider } = await import('../src/renderer/src/components/FileMentionChip')
  const { Answer } = await import('../src/renderer/src/components/turn/TurnMessages')
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { useFilesStore } = await import('../src/renderer/src/stores/files')
  const { useFileChangesStore } = await import('../src/renderer/src/stores/file-changes')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')

  const projectCwd = '/Users/smoose/Documents/小说/故人西来'
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const realOpenFileTab = useSessionsStore.getState().openFileTab
  useSessionsStore.setState({
    projects: [{ cwd: projectCwd, name: '故人西来', sessions: [], worktrees: [] }],
    openTabs: [{ id: 's1', cwd: projectCwd, title: '故人西来', kind: 'project', loadState: 'ready' }],
    runtime: { s1: { leafId: 'leaf-1', isStreaming: false } as never },
    openFileTab: async (cwd: string, path: string, options?: { preview?: boolean }) => {
      openedTabs.push({ cwd, path, preview: options?.preview })
      await realOpenFileTab(cwd, path, options)
    }
  })
  useFileChangesStore.setState({
    bySession: {
      s1: {
        leafId: 'leaf-1',
        summary: {
          leafId: 'leaf-1',
          files: [
            {
              path: `${projectCwd}/正文/002-卷一-第二章-两口井.md`,
              relativePath: '正文/002-卷一-第二章-两口井.md',
              added: 371,
              removed: 2,
              unknownOperations: 0,
              operationCount: 1
            }
          ],
          turns: {}
        },
        error: null
      }
    }
  })

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  const markdown = [
    '老大，第二章写好啦：[《两口井》](正文/002-卷一-第二章-两口井.md)。',
    '代码定位：[`window.ts`](file:///Users/smoose/Documents/%E5%B0%8F%E8%AF%B4/%E6%95%85%E4%BA%BA%E8%A5%BF%E6%9D%A5/src/window.ts#L42)。',
    '外部文件：[外部报告](/Users/smoose/Desktop/report.pdf)。',
    '目录链接：[正文目录](正文)。',
    '网页：[文档](https://example.com)。',
    '写好嘞！ `/Users/smoose/Documents/小说/故人西来/红线啦啦啦.md` ，接口是 `/models` ，命令 `bun run test` ，属性 `window.api`。',
    '![bad](file:///etc/passwd)'
  ].join('\n\n')

  try {
    await act(async () => {
      root.render(
        createElement(
          FileMentionProvider,
          { value: { cwd: projectCwd, sessionId: 's1' } },
          createElement(FileMentionChip, { path: '大纲.md', opensFile: true }),
          createElement(Answer, { blocks: [{ type: 'text', text: markdown }] })
        )
      )
    })

    const links = [...container.querySelectorAll('a')]
    assert.equal(links.length, 6)
    const codeFileLinks = [...container.querySelectorAll('[data-file-code]')]
    assert.equal(codeFileLinks.length, 1, 'only the real file path backtick span becomes interactive; [`window.ts`](...) stays nested once')
    assert.equal(codeFileLinks[0]?.getAttribute('data-file-code'), `${projectCwd}/红线啦啦啦.md`)

    // Local image with file:// must not keep a file:// src in chat output.
    const img = container.querySelector('img')
    assert.ok(!img?.getAttribute('src')?.startsWith('file:'), 'file:// image src must be sanitized')

    // External https link keeps target="_blank".
    assert.equal(links[4]?.getAttribute('target'), '_blank')
    assert.equal(links[0]?.getAttribute('target'), null)

    // Hovering 《两口井》 opens the hover card with path, line count, and session edit stats (+371 -2).
    await act(async () => {
      links[0]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    const card = document.body.querySelector('[data-slot="hover-card-content"]')
    assert.ok(card, 'hover card opens for local file link')
    assert.ok(card.textContent?.includes('002-卷一-第二章-两口井.md'))
    assert.ok(card.textContent?.includes('369 行'))
    assert.ok(card.textContent?.includes('已在此聊天中编辑'))
    assert.ok(card.textContent?.includes('+371'))
    assert.ok(card.textContent?.includes('−2'))

    // Clicking 《两口井》 opens it in a workspace preview file tab.
    await act(async () => {
      links[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.deepEqual(openedTabs, [{ cwd: projectCwd, path: '正文/002-卷一-第二章-两口井.md', preview: true }])
    assert.equal(useSessionsStore.getState().openTabs.filter((t) => t.kind === 'file').length, 1)

    // Clicking file:///...#L42 inside the workspace reuses the same preview tab AND reveals line 42.
    await act(async () => {
      links[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.deepEqual(openedTabs[1], { cwd: projectCwd, path: 'src/window.ts', preview: true })
    assert.equal(useSessionsStore.getState().openTabs.filter((t) => t.kind === 'file').length, 1, 'reuses the single preview tab')
    assert.deepEqual(useFilesStore.getState().reveal, {
      cwd: projectCwd,
      path: 'src/window.ts',
      line: 42,
      token: 1
    })

    // Clicking a file outside open workspaces delegates to OS default app via openLocalFileExternally.
    await act(async () => {
      links[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.deepEqual(openedExternally, ['/Users/smoose/Desktop/report.pdf'])

    // Clicking a workspace directory opens the directory externally instead of a broken file tab.
    await act(async () => {
      links[3]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.deepEqual(workspaceExternally, [{ cwd: projectCwd, path: '正文' }])

    // Clicking the inline-code path `/Users/.../红线啦啦啦.md` resolves to the open workspace and reuses the preview tab.
    await act(async () => {
      codeFileLinks[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.deepEqual(openedTabs[2], { cwd: projectCwd, path: '红线啦啦啦.md', preview: true })
    assert.equal(useSessionsStore.getState().openTabs.filter((t) => t.kind === 'file').length, 1)

    // Clicking an `@file` mention chip in a user message also previews in the same tab.
    const mentionChip = container.querySelector<HTMLButtonElement>('button[aria-label="大纲.md"]')!
    await act(async () => {
      mentionChip.click()
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.deepEqual(openedTabs[3], { cwd: projectCwd, path: '大纲.md', preview: true })
    const fileTabs = useSessionsStore.getState().openTabs.filter((t) => t.kind === 'file')
    assert.equal(fileTabs.length, 1, 'all conversation file references share one preview tab')
    assert.equal(fileTabs[0]?.path, '大纲.md')
    assert.equal(fileTabs[0]?.preview, true)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

test('assistant Markdown file links show FileMention hover card and open workspace tabs or external files', async () => {
  const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--markdown-file-links-dom'])
  assert.equal(code, 0, stdout + stderr)
})
