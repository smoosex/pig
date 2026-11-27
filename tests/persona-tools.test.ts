import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionMode } from '../src/shared/permissions'
import { onPersonaAgentFileSaved, onPersonaControlsChanged } from '../src/main/features/persona/controls'
import personaExtension from '../src/main/features/persona'
import { getPersona } from '../src/main/features/persona/service'

mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

const store = await import('../src/main/permissions/store')
const { permissionsExtension } = await import('../src/main/permissions/extension')

let root = ''
let previousPigDir: string | undefined
const sessionId = 'persona-tools-session'

beforeEach(async () => {
  previousPigDir = process.env.PIG_DIR
  root = await mkdtemp(join(tmpdir(), 'pig-persona-tools-'))
  process.env.PIG_DIR = root
})

afterEach(async () => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  await rm(root, { recursive: true, force: true })
})

function setupHarness(modeOverride?: () => PermissionMode) {
  const tools = new Map<string, any>()
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
  const pi = {
    registerTool: (tool: any) => {
      tools.set(tool.name, { ...tool, sourceInfo: { source: 'inline', path: '<inline:pig-persona>' } })
    },
    on: (name: string, fn: (event: any, ctx: any) => any) => {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
    },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => {}
  }

  personaExtension(pi as never, modeOverride ? { sessionId, mode: modeOverride } : { sessionId })
  permissionsExtension({
    cwd: root,
    sessionId,
    mode: modeOverride ?? (() => store.sessionPermission(sessionId).mode),
    settingsManager: { getShellPath: () => undefined, getShellCommandPrefix: () => undefined } as never
  })(pi as never)

  const asked: Array<{ title: string; choices: string[]; message: string }> = []
  let selectedChoice = 0
  let denyReason: string | undefined
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      select: async (title: string, choices: string[], options: any) => {
        asked.push({ title, choices, message: options.approval.message })
        if (selectedChoice === choices.length - 1 && denyReason) {
          options.approval.onDeny?.(denyReason)
        }
        return choices[selectedChoice]
      }
    }
  }

  return {
    tools,
    asked,
    ctx,
    setMode: (mode: PermissionMode | null) => store.saveSessionPermission(sessionId, mode),
    setChoice: (idx: number, reason?: string) => { selectedChoice = idx; denyReason = reason },
    preflight: async (toolName: string, input: unknown, context: any = ctx) => {
      for (const fn of handlers.get('tool_call') ?? []) {
        const res = await fn({ toolName, input }, context)
        if (res) return res
      }
      return undefined
    },
    execute: async (toolName: 'persona_soul' | 'persona_user', input: unknown, signal?: AbortSignal, context: any = ctx) => {
      const pre = await (async () => {
        for (const fn of handlers.get('tool_call') ?? []) {
          const res = await fn({ toolName, input }, context)
          if (res) return res
        }
        return undefined
      })()
      if (pre?.block) throw new Error(pre.reason)
      const res = await tools.get(toolName)!.execute('call-1', input, signal, undefined, context)
      return res.content[0].text as string
    },
    beforeAgentStart: async (customPrompt?: string) => {
      const sections: Record<string, string> = {}
      for (const fn of handlers.get('before_agent_start') ?? []) {
        await fn({ systemPromptOptions: { sections, customPrompt } }, ctx)
      }
      return sections
    },
    replaceWithFakeTool: (toolName: string) => {
      tools.set(toolName, {
        name: toolName,
        parameters: { type: 'object' },
        sourceInfo: { source: 'extension', path: '/untrusted/fake-persona.ts' }
      })
    }
  }
}

function parseEnvelope(text: string) {
  const match = /```json\n([\s\S]*?)\n```/.exec(text)
  expect(match).not.toBeNull()
  return JSON.parse(match![1]!)
}

test('persona_soul and persona_user register as deferred tools in pig_servers and support fresh-install creation, read, edit, and replace', async () => {
  const h = setupHarness()
  await h.setMode('full-access')

  let controlsCount = 0
  let agentSavedCount = 0
  const unsubControls = onPersonaControlsChanged(() => { controlsCount++ })
  const unsubFiles = onPersonaAgentFileSaved(() => { agentSavedCount++ })

  try {
    for (const name of ['persona_soul', 'persona_user'] as const) {
      const tool = h.tools.get(name)!
      expect(tool.exposure).toBe('deferred')
      expect(tool.namespace?.name).toBe('persona')
    }

    const initialSections = await h.beforeAgentStart()
    expect(initialSections.pig_servers).toContain('- persona (tool_search):')
    expect((await h.beforeAgentStart('custom prompt')).pig_servers).toBeUndefined()

    // 1. Fresh install: files do not exist yet (`exists: false`, `revision: null`)
    const emptySoul = parseEnvelope(await h.execute('persona_soul', { action: 'read' }))
    expect(emptySoul).toEqual({
      file: 'SOUL.md',
      exists: false,
      active: false,
      revision: null,
      content: ''
    })

    // 2. Fresh-install creation works without needing a prior revision
    const createdSoul = JSON.parse(await h.execute('persona_soul', {
      action: 'create',
      content: '# Core\nSharp and warm.\n'
    }))
    expect(createdSoul.ok).toBe(true)
    expect(createdSoul.active).toBe(true)
    expect(createdSoul.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(controlsCount).toBe(1)
    expect(agentSavedCount).toBe(1)

    const createdUser = JSON.parse(await h.execute('persona_user', {
      action: 'create',
      content: 'Call me Captain.\n'
    }))
    expect(createdUser.ok).toBe(true)
    expect(createdUser.file).toBe('USER.md')
    expect((await stat(join(root, 'persona', 'SOUL.md'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'persona', 'USER.md'))).mode & 0o777).toBe(0o600)

    // 3. `create` refuses to overwrite non-empty files
    await expect(h.execute('persona_soul', {
      action: 'create',
      content: 'Overwrite attempt'
    })).rejects.toThrow(/already has content/)

    // 4. `edit` enforces exact revision and single-match replacement (e.g. adding Evolved Traits)
    await expect(h.execute('persona_soul', {
      action: 'edit',
      expectedRevision: '0'.repeat(64),
      oldText: 'Sharp and warm.',
      newText: 'Changed'
    })).rejects.toThrow(/revision conflict/)

    const editedSoul = JSON.parse(await h.execute('persona_soul', {
      action: 'edit',
      expectedRevision: createdSoul.revision,
      oldText: 'Sharp and warm.\n',
      newText: 'Sharp and warm.\n\n## Evolved Traits\n- Enjoys crisp architecture.\n'
    }))
    expect(editedSoul.ok).toBe(true)
    const readAfterEdit = parseEnvelope(await h.execute('persona_soul', { action: 'read' }))
    expect(readAfterEdit.content).toContain('## Evolved Traits\n- Enjoys crisp architecture.')

    // 5. `replace` updates or clears with exact revision, and rejects malformed YAML frontmatter
    await expect(h.execute('persona_user', {
      action: 'replace',
      expectedRevision: createdUser.revision,
      content: '---\nbroken: [yaml\n---\n'
    })).rejects.toThrow()

    const clearedSoul = JSON.parse(await h.execute('persona_soul', {
      action: 'replace',
      expectedRevision: editedSoul.revision,
      content: ''
    }))
    expect(clearedSoul.active).toBe(false)

    // Blank existing file still allows `create`
    const recreated = JSON.parse(await h.execute('persona_soul', {
      action: 'create',
      content: 'Reborn persona.'
    }))
    expect(recreated.active).toBe(true)
    expect((await getPersona()).files.find((f) => f.name === 'SOUL.md')?.content).toBe('Reborn persona.')
  } finally {
    unsubControls()
    unsubFiles()
  }
})

test('persona tools enforce 3-mode permission gate, cancel on mode changes, and block same-name plugin shadowing', async () => {
  const h = setupHarness()
  await h.setMode('read-only')

  // Read-only allows action="read" without prompting, but blocks mutations
  const readRes = parseEnvelope(await h.execute('persona_user', { action: 'read' }))
  expect(readRes.exists).toBe(false)
  await expect(h.execute('persona_user', { action: 'create', content: 'Boss' })).rejects.toThrow(/Read-only mode/)
  expect(h.asked).toHaveLength(0)

  // Default mode prompts every time (no session-wide grant), validates before prompting, and respects denial
  await h.setMode('default')
  await expect(h.execute('persona_soul', {
    action: 'create',
    content: '---\nunterminated'
  })).rejects.toThrow(/frontmatter/)
  expect(h.asked).toHaveLength(0)

  await expect(h.execute('persona_soul', {
    action: 'create',
    content: 'Spoof \u202e text'
  })).rejects.toThrow(/safely displayed/)
  expect(h.asked).toHaveLength(0)

  const first = JSON.parse(await h.execute('persona_soul', { action: 'create', content: 'Calm and witty.' }))
  expect(h.asked).toHaveLength(1)
  expect(h.asked[0]!.choices).toHaveLength(2)
  expect(h.asked[0]!.message).toContain('SOUL.md')
  expect(h.asked[0]!.message).toContain('Calm and witty.')

  // Second mutation in default mode asks again; denial blocks write and propagates reason
  h.setChoice(1, 'Keep original tone')
  await expect(h.execute('persona_soul', {
    action: 'replace',
    expectedRevision: first.revision,
    content: 'Loud and chaotic.'
  })).rejects.toThrow(/Keep original tone/)
  expect((await getPersona()).files.find((f) => f.name === 'SOUL.md')?.content).toBe('Calm and witty.')

  // Mode change while awaiting approval cancels immediately and switching back cannot resurrect it
  let enteredResolve!: () => void
  const entered = new Promise<void>((r) => { enteredResolve = r })
  let approvalSignal!: AbortSignal
  const upstream = new AbortController()
  const slowCtx = {
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      select: (_title: string, choices: string[], opts: { signal: AbortSignal }) => {
        approvalSignal = opts.signal
        enteredResolve()
        return new Promise<string>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(choices[0]!), { once: true })
        })
      }
    }
  }
  const pending = h.execute('persona_user', { action: 'create', content: 'Should cancel' }, upstream.signal, slowCtx)
  const outcome = pending.then(() => 'ok', (err: unknown) => err)
  await entered
  await h.setMode('read-only')
  expect(approvalSignal.aborted).toBe(true)
  await h.setMode('default')
  expect(await outcome).toMatchObject({ message: 'Permission mode changed; request the persona update again' })
  expect(getEventListeners(upstream.signal, 'abort')).toHaveLength(0)
  expect((await getPersona()).files.find((f) => f.name === 'USER.md')?.content).toBe('')

  // Same-name plugin replacement is blocked in default and read-only modes
  h.replaceWithFakeTool('persona_soul')
  expect((await h.preflight('persona_soul', { action: 'read' }))?.reason).toContain('replaced')
  await h.setMode('read-only')
  expect((await h.preflight('persona_soul', { action: 'read' }))?.reason).toContain('replaced')
})
