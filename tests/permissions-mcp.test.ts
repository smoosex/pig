/** MCP tool calls under the permission modes: the decision table and the extension's tool_call gate. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({ app: { isPackaged: false } }))
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolAnnotations } from '@earendil-works/pi-coding-agent'
import type { PermissionMode } from '../src/shared/permissions'
import { mcpDecision, mcpNeedsApproval, SESSION_TOOLS_PATH } from '../src/main/permissions/mcp'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-permissions-mcp-')))
const previousPigDir = process.env.PIG_DIR

beforeAll(() => { process.env.PIG_DIR = root })
afterAll(() => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  rmSync(root, { recursive: true, force: true })
})

test('Codex auto rule: only declared read-only or non-destructive closed-world tools skip approval', () => {
  expect(mcpNeedsApproval(undefined)).toBe(true)
  expect(mcpNeedsApproval({ readOnlyHint: true })).toBe(false)
  expect(mcpNeedsApproval({ readOnlyHint: true, destructiveHint: true })).toBe(true)
  expect(mcpNeedsApproval({ destructiveHint: false })).toBe(true)
  expect(mcpNeedsApproval({ destructiveHint: false, openWorldHint: false })).toBe(false)
  expect(mcpNeedsApproval({ destructiveHint: false, openWorldHint: true })).toBe(true)
})

test('modes and per-server approvals decide allow, ask or deny', () => {
  const readOnly: ToolAnnotations = { readOnlyHint: true }
  expect(mcpDecision('full-access', 'prompt', undefined)).toBe('allow')
  expect(mcpDecision('read-only', 'auto', readOnly)).toBe('allow')
  expect(mcpDecision('read-only', 'approve', undefined)).toBe('deny')
  expect(mcpDecision('read-only', 'prompt', readOnly)).toBe('deny')
  expect(mcpDecision('default', 'auto', readOnly)).toBe('allow')
  expect(mcpDecision('default', 'auto', undefined)).toBe('ask')
  expect(mcpDecision('default', 'prompt', readOnly)).toBe('ask')
  expect(mcpDecision('default', 'approve', { destructiveHint: true })).toBe('allow')
})

type Handler = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>

async function load(mode: PermissionMode, extra: object[]) {
  const { permissionsExtension } = await import('../src/main/permissions/extension')
  const tools = new Map<string, { name: string; parameters: unknown; sourceInfo: { path: string } }>()
  const handlers = new Map<string, Handler>()
  const pi = {
    registerTool: (tool: { name: string; parameters: unknown }) => tools.set(tool.name, { ...tool, sourceInfo: { path: '<inline:2>' } }),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getAllTools: () => [...tools.values(), ...extra],
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => {}
  }
  const settingsManager = { getShellPath: () => undefined, getShellCommandPrefix: () => undefined, getDefaultTools: () => undefined }
  await permissionsExtension({ cwd: root, settingsManager: settingsManager as never, sessionId: `mcp-${mode}-${Math.random()}`, mode: () => mode })(pi as never)
  return handlers.get('tool_call')!
}

const mcpTool = (tool: string, annotations?: ToolAnnotations, path = SESSION_TOOLS_PATH) => ({
  name: `mcp__docs__${tool}`, parameters: {}, sourceInfo: { path },
  namespace: { name: 'mcp__docs', aliases: ['docs'] }, ...(annotations ? { annotations } : {})
})

function context(answer: 'once' | 'session' | 'deny') {
  const asked: string[] = []
  return {
    asked,
    ctx: {
      hasUI: true, signal: undefined,
      ui: { select: async (title: string, options: string[]) => { asked.push(title); return options[answer === 'once' ? 0 : answer === 'session' ? 1 : 2] } }
    }
  }
}

test('default mode asks for unannotated tools and remembers a session answer per server', async () => {
  const toolCall = await load('default', [mcpTool('search', { readOnlyHint: true }), mcpTool('write'), mcpTool('delete', { destructiveHint: true })])
  const call = (tool: string, ctx: unknown) => toolCall({ toolName: `mcp__docs__${tool}`, input: { q: 1 } }, ctx)

  const free = context('deny')
  expect(await call('search', free.ctx)).toBeUndefined()
  expect(free.asked).toEqual([])

  const denied = context('deny')
  await expect(call('write', denied.ctx)).rejects.toThrow(/did not allow/)
  expect(denied.asked).toHaveLength(1)

  const session = context('session')
  expect(await call('write', session.ctx)).toBeUndefined()
  // One session answer covers the server's other tools.
  const later = context('deny')
  expect(await call('delete', later.ctx)).toBeUndefined()
  expect(later.asked).toEqual([])
})

test('read-only mode refuses tools not marked read-only without asking', async () => {
  const toolCall = await load('read-only', [mcpTool('search', { readOnlyHint: true }), mcpTool('write')])
  const { ctx, asked } = context('once')
  expect(await toolCall({ toolName: 'mcp__docs__search', input: {} }, ctx)).toBeUndefined()
  expect((await toolCall({ toolName: 'mcp__docs__write', input: {} }, ctx))?.block).toBe(true)
  expect(asked).toEqual([])
})

test('only MCP tools from Pig session tools count', async () => {
  const toolCall = await load('read-only', [mcpTool('impostor', undefined, '/plugins/fake.ts')])
  const { ctx } = context('once')
  // A plugin tool with an MCP-looking namespace is not judged by MCP rules (plugins are trusted code).
  expect(await toolCall({ toolName: 'mcp__docs__impostor', input: {} }, ctx)).toBeUndefined()
})

test('an MCP tool without its server alias is refused rather than judged as auto', async () => {
  const toolCall = await load('default', [{ ...mcpTool('search', { readOnlyHint: true }), namespace: { name: 'mcp__docs' } }])
  const { ctx, asked } = context('once')
  expect((await toolCall({ toolName: 'mcp__docs__search', input: {} }, ctx))?.reason).toMatch(/does not name its server/)
  expect(asked).toEqual([])
})

test('a per-server approval set by the user overrides annotations', async () => {
  const { updatePermissionSettings } = await import('../src/main/permissions/store')
  await updatePermissionSettings((current) => ({ ...current, mcp: { docs: 'prompt' } }))
  const prompted = await load('default', [mcpTool('search', { readOnlyHint: true })])
  const asking = context('once')
  expect(await prompted({ toolName: 'mcp__docs__search', input: {} }, asking.ctx)).toBeUndefined()
  expect(asking.asked).toHaveLength(1)

  // Read-only cannot ask, so an ask-every-call server refuses even its read-only tools, and says why.
  const readOnly = await load('read-only', [mcpTool('search', { readOnlyHint: true })])
  expect((await readOnly({ toolName: 'mcp__docs__search', input: {} }, asking.ctx))?.reason).toMatch(/ask for every call/)

  await updatePermissionSettings((current) => ({ ...current, mcp: { docs: 'approve' } }))
  const approved = await load('default', [mcpTool('delete', { destructiveHint: true })])
  const silent = context('deny')
  expect(await approved({ toolName: 'mcp__docs__delete', input: {} }, silent.ctx)).toBeUndefined()
  expect(silent.asked).toEqual([])
  await updatePermissionSettings((current) => ({ ...current, mcp: {} }))
})
