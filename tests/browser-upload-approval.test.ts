/** Upload cards and permission modes without a real browser, user files or model. */
import { expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { PermissionMode } from '../src/shared/permissions'
import type { BrowserAgentDeps } from '../src/main/browser/agent'
import { emptyBrowserState } from '../src/main/browser/host'
import type { ApprovalOptions } from '../src/main/permissions/approval'

mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
const { approveBrowserUpload } = await import('../src/main/browser/upload-approval')
const { BrowserAgentController } = await import('../src/main/browser/agent')
const { applyLocaleSetting, currentLocale } = await import('../src/main/i18n')
const { saveSessionPermission } = await import('../src/main/permissions/store')
const { clearSandboxTemporary } = await import('../src/main/sandbox/temporary')

test('upload approval displays actual paths and untrusted page safely, warns only for protected files, and asks once each time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-upload-approval-'))
  const previousPig = process.env.PIG_DIR
  const previousPi = process.env.PI_CODING_AGENT_DIR
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi')
  const previousLocale = currentLocale()
  applyLocaleSetting('en')
  try {
    const cwd = join(root, 'pig', 'worktrees', 'project', 'task')
    await mkdir(cwd, { recursive: true })
    const canonical = await realpath(cwd)
    const protectedFile = join(await realpath(root), 'pig', 'mcp-auth.json')
    const harmless = join(canonical, 'report.txt')
    const similarPrefix = join(root, 'pig-other', 'ordinary.txt')
    const selected = [
      { requested: '/tmp/alias\nforged', resolved: protectedFile, size: 12 },
      { requested: harmless, resolved: harmless, size: 8 },
      { requested: similarPrefix, resolved: similarPrefix, size: 9 }
    ]
    const calls: { title: string; choices: string[]; options: ApprovalOptions }[] = []
    let answer: 'allow' | 'deny' | 'cancel' = 'allow'
    const ui: Pick<ExtensionUIContext, 'select'> = { async select(title, choices, options) {
      calls.push({ title, choices, options: options as ApprovalOptions })
      return answer === 'allow' ? choices[0] : answer === 'deny' ? choices.at(-1) : undefined
    } }
    const page = { url: 'https://example.test:8443/form?token=private-query#private-fragment', title: 'Page\nINJECT\u202eZZ' }
    const signal = new AbortController().signal
    for (let i = 0; i < 2; i++) await approveBrowserUpload('session-1', { cwd, ui }, page, 'e1', selected, signal)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.choices).toEqual(['Allow once', 'Deny'])
    expect(calls[0]!.options.signal).toBe(signal)
    const message = calls[0]!.options.approval.message
    expect(message).toContain('https://example.test:8443/form')
    expect(message).not.toContain('private-query')
    expect(message).not.toContain('private-fragment')
    expect(message).toContain('Page\\nINJECT\\u202eZZ')
    expect(message).toContain('/tmp/alias\\nforged')
    expect(message).toContain(protectedFile)
    expect(message).toContain(harmless)
    expect(message).toContain(similarPrefix)
    expect(message.split('\n').filter(line => line.includes('⚠'))).toEqual([
      '⚠ potentially sensitive protected path', expect.stringContaining(`- ⚠ "${protectedFile}"`)
    ])
    expect(message).toContain('does not guarantee the upload destination')

    const longPage = { url: `https://example.test/${'x'.repeat(3000)}?token=hidden`, title: 'Long page' }
    await approveBrowserUpload('session-1', { cwd, ui }, longPage, 'e2', [selected[1]!, selected[0]!])
    const longMessage = calls.at(-1)!.options.approval.message
    expect(longMessage).toContain('⚠ potentially sensitive protected path')
    expect(longMessage).toContain(`- ⚠ "${protectedFile}"`)
    expect(longMessage.indexOf('The page can read these files')).toBeLessThan(longMessage.indexOf(harmless))
    expect(longMessage.indexOf('⚠ potentially sensitive protected path')).toBeLessThan(longMessage.indexOf(harmless))
    expect(longMessage.indexOf(harmless)).toBeLessThan(longMessage.indexOf(protectedFile))
    expect(longMessage.indexOf(protectedFile)).toBeLessThan(longMessage.indexOf('does not guarantee the upload destination'))
    expect(longMessage.indexOf('does not guarantee the upload destination')).toBeLessThan(longMessage.indexOf('Page (query and fragment omitted):'))
    expect(longMessage).toContain(`https://example.test/${'x'.repeat(3000)}`)
    expect(longMessage).not.toContain('token=hidden')
    const questionCount = calls.length
    await expect(approveBrowserUpload('session-1', { cwd, ui }, { url: `https://example.test/${'x'.repeat(16_384)}`, title: 'Too long' }, 'e2', [selected[0]!]))
      .rejects.toThrow('page address is too long to display')
    expect(calls).toHaveLength(questionCount)
    await approveBrowserUpload('session-1', { cwd, ui }, page, 'e1', [selected[1]!])
    expect(calls.at(-1)!.options.approval.message).not.toContain('⚠')

    applyLocaleSetting('zh-CN')
    await approveBrowserUpload('session-1', { cwd, ui }, longPage, 'e2', [selected[1]!, selected[0]!])
    const chineseMessage = calls.at(-1)!.options.approval.message
    expect(chineseMessage).toContain('⚠ 可能是受保护的敏感路径')
    expect(chineseMessage.indexOf('网页可以读取这些文件')).toBeLessThan(chineseMessage.indexOf(harmless))
    expect(chineseMessage.indexOf('⚠ 可能是受保护的敏感路径')).toBeLessThan(chineseMessage.indexOf(harmless))
    expect(chineseMessage.indexOf(protectedFile)).toBeLessThan(chineseMessage.indexOf('页面地址不代表实际上传目的地'))
    expect(chineseMessage.indexOf('页面地址不代表实际上传目的地')).toBeLessThan(chineseMessage.indexOf('网页（不含查询参数和片段）：'))
    applyLocaleSetting('en')
    answer = 'deny'
    await expect(approveBrowserUpload('session-1', { cwd, ui }, page, 'e1', selected)).rejects.toThrow('did not allow')
    answer = 'cancel'
    await expect(approveBrowserUpload('session-1', { cwd, ui }, page, 'e1', selected)).rejects.toThrow('cancelled')
    await expect(approveBrowserUpload('session-1', { cwd }, page, 'e1', selected)).rejects.toThrow('cannot ask')
    await expect(approveBrowserUpload('session-1', { cwd, ui }, page, 'e1', selected, AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped')
  } finally {
    applyLocaleSetting(previousLocale)
    clearSandboxTemporary()
    if (previousPig === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previousPig
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousPi
    await rm(root, { recursive: true, force: true })
  }
})

test('read-only refuses, full access bypasses the prompt, default requires approval and mode changes cancel it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-upload-mode-'))
  const previousPig = process.env.PIG_DIR
  const previousPi = process.env.PI_CODING_AGENT_DIR
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi')
  try {
    const win = { isDestroyed: () => false } as BrowserWindow
    let mode: PermissionMode = 'read-only'
    let attempts = 0, assigned = 0, questions = 0
    let response: 'allow' | 'deny' | 'pending' = 'allow'
    let entered!: () => void, allow!: () => void
    let waiting = new Promise<void>(resolve => { entered = resolve })
    let answer = new Promise<string>(resolve => { allow = () => resolve('Allow once') })
    const ui: Pick<ExtensionUIContext, 'select'> = { async select(_title, choices) {
      questions++
      if (response === 'pending') { entered(); return answer }
      return response === 'allow' ? choices[0] : choices.at(-1)
    } }
    const host = {
      agentOf: () => 'session-1',
      waitForLoad: async () => true,
      getState: () => ({ ...emptyBrowserState('browser:a'), url: 'https://example.test/form' }),
      async upload(_win, _id, _session, _ref, _files, options) {
        attempts++
        await options.approve({ url: 'https://example.test/form?secret=hidden', title: 'Form' },
          [{ requested: join(root, 'file'), resolved: join(root, 'file'), size: 4 }], options.signal)
        options.assertPolicy()
        assigned++
      }
    } satisfies Partial<BrowserAgentDeps['host']>
    const controller = new BrowserAgentController({
      host: host as unknown as BrowserAgentDeps['host'], sessionWindow: () => win, isSessionLive: () => true,
      browsers: () => ['browser:a'], requestTab: async () => 'browser:a', activateTab: async () => {}, closeTab: async () => {},
      permissionMode: () => mode
    })
    const context = { cwd: root, ui }
    await expect(controller.upload('session-1', 'e1', ['/private'], context)).rejects.toThrow('Read-only')
    expect(attempts).toBe(0)
    mode = 'full-access'
    await controller.upload('session-1', 'e1', ['/private'], { cwd: root })
    expect([assigned, questions]).toEqual([1, 0])
    mode = 'default'
    await expect(controller.upload('session-1', 'e1', ['/private'], { cwd: root })).rejects.toThrow('cannot ask')
    await controller.upload('session-1', 'e1', ['/private'], context)
    response = 'deny'
    await expect(controller.upload('session-1', 'e1', ['/private'], context)).rejects.toThrow('did not allow')
    expect([assigned, questions]).toEqual([2, 2])
    response = 'pending'
    const pending = controller.upload('session-1', 'e1', ['/private'], context)
    await waiting
    mode = 'read-only'
    await saveSessionPermission('unrelated-session', 'default')
    await expect(pending).rejects.toThrow('Permission mode changed')
    allow()
    await Promise.resolve()
    expect(assigned).toBe(2)
    mode = 'default'
    waiting = new Promise<void>(resolve => { entered = resolve })
    answer = new Promise<string>(resolve => { allow = () => resolve('Allow once') })
    const stop = new AbortController()
    const cancelled = controller.upload('session-1', 'e1', ['/private'], context, stop.signal)
    await waiting
    stop.abort(new Error('user stopped'))
    await expect(cancelled).rejects.toThrow('user stopped')
    allow()
    await Promise.resolve()
    expect(assigned).toBe(2)
  } finally {
    clearSandboxTemporary()
    if (previousPig === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previousPig
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousPi
    await rm(root, { recursive: true, force: true })
  }
})
