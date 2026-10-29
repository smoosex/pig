/** PowerShell preserves UTF-8 output initialization through the permission-checked backend. */
import { expect, mock, test } from 'bun:test'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PermissionMode } from '../src/shared/permissions'

mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
const commands: string[] = []
let beforeSpawn: (() => void) | undefined
let checked = 0
mock.module('../src/main/sandbox/shell', () => ({
  guardedShellOperations: (_path: unknown, guard: { check(): void; dispose(): void }) => ({
    exec: async (command: string, _cwd: string, options: { onData(data: Buffer): void }) => {
      beforeSpawn?.()
      guard.check()
      checked++
      guard.dispose()
      commands.push(command)
      options.onData(Buffer.from('中文输出'))
      return { exitCode: 0 }
    }
  })
}))

const { permissionsExtension } = await import('../src/main/permissions/extension')

test('PowerShell initializes UTF-8 before the unchanged command and still checks permissions before spawn', async () => {
  const tools = new Map<string, ToolDefinition>()
  let mode: PermissionMode = 'full-access'
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: () => {},
    getAllTools: () => [...tools.values()]
  }
  const settingsManager = { getShellPath: () => undefined, getShellCommandPrefix: () => undefined }
  await permissionsExtension({ cwd: process.cwd(), sessionId: 'powershell-test', settingsManager: settingsManager as never, mode: () => mode })(pi as unknown as ExtensionAPI)
  const tool = tools.get('powershell')!
  const signal = new AbortController().signal
  const command = "Write-Output '中文输出'"
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => 'powershell-test', getSessionFile: () => undefined } } as never
  const result = await tool.execute('utf8', { command }, signal, undefined, ctx)
  expect(commands).toEqual([`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n${command}`])
  expect(result.content).toContainEqual({ type: 'text', text: '中文输出' })
  expect(checked).toBe(1)

  beforeSpawn = () => { mode = 'read-only' }
  try {
    await expect(tool.execute('tightened', { command }, signal, undefined, ctx)).rejects.toThrow('Permission mode changed')
    expect(commands).toHaveLength(1)
    expect(checked).toBe(1)
  } finally { beforeSpawn = undefined }
})
