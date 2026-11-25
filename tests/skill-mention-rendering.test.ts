import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-skill-mentions-'))
  mock.module('../src/main/i18n', () => ({ t: (key: string) => key }))

  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    api: {
      listSkills: async () => ({ skills: [], diagnostics: [] }),
      getCommands: async () => []
    }
  })

  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { normalizeSessionPrompt } = await import('../src/main/pi/prompt-input')
  const { displayTurnsFromEntries } = await import('../src/main/pi/session-display-model')
  const { restoreSessionUserPrompt } = await import('../src/main/pi/session-user-prompt')
  const { previewText } = await import('../src/main/pi/session-preview')
  const { createPastedTextDeliveryMetadata, PASTED_TEXT_CUSTOM_TYPE } = await import('../src/shared/pasted-text')
  const { toTurn } = await import('../src/renderer/src/chat/display-turns')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { UserBubble } = await import('../src/renderer/src/components/turn/TurnMessages')

  const container = document.createElement('div')
  document.body.append(container)
  const reactRoot = createRoot(container)

  try {
    // 1. Prompt normalization when the user deleted the space after a skill chip (`[diffs]帮我看看`).
    const adjacent = normalizeSessionPrompt({
      text: '/skill:diffs帮我看看',
      skillMentions: [{ name: 'diffs', start: 0, end: 12 }]
    })
    assert.equal(adjacent.modelText, '/skill:diffs帮我看看')
    assert.equal(adjacent.piModelText, '/skill:diffs 帮我看看')
    assert.equal(adjacent.metadata?.version, 2)
    assert.deepEqual(adjacent.displayMetadata?.segments, [
      { type: 'skill', name: 'diffs', text: '/skill:diffs' },
      { type: 'text', text: '帮我看看' }
    ])

    // 2. Persisted v3 skill prompt round-trips display segments and restores `skillMentions`.
    const manager = SessionManager.create(root, join(root, 'sessions'))
    const expanded = [
      '<skill name="diffs" location="/repo/.agents/skills/diffs/SKILL.md">',
      'References are relative to /repo/.agents/skills/diffs.',
      '',
      '# Diffs full instructions',
      '</skill>',
      '',
      '帮我看看'
    ].join('\n')
    manager.appendCustomEntry(
      PASTED_TEXT_CUSTOM_TYPE,
      createPastedTextDeliveryMetadata(adjacent.modelText, adjacent.metadata!, expanded)
    )
    const saved = manager.appendMessage({ role: 'user', content: expanded, timestamp: 10 })

    // 3. Historical expanded `<skill ...>` entry without `pig.pasted-text` metadata.
    const legacyExpanded = [
      '<skill name="shadcn" location="/repo/.agents/skills/shadcn/SKILL.md">',
      'References are relative to /repo/.agents/skills/shadcn.',
      '',
      '# Shadcn full instructions that must stay hidden in bubbles',
      '</skill>',
      '',
      '添加按钮组件'
    ].join('\n')
    const legacyId = manager.appendMessage({ role: 'user', content: legacyExpanded, timestamp: 20 })

    const reopened = SessionManager.open(manager.getSessionFile()!)
    const turns = displayTurnsFromEntries('session-1', reopened.getBranch())
    assert.equal(turns.length, 2)

    // Restoring both new (v3) and legacy expanded entries yields `skillMentions`.
    const restoredNew = restoreSessionUserPrompt(reopened, reopened.getEntry(saved)!)
    assert.equal(restoredNew.prompt.text, '/skill:diffs帮我看看')
    assert.deepEqual(restoredNew.prompt.skillMentions, [{ name: 'diffs', start: 0, end: 12 }])

    const restoredLegacy = restoreSessionUserPrompt(reopened, reopened.getEntry(legacyId)!)
    assert.equal(restoredLegacy.prompt.text, '/skill:shadcn 添加按钮组件')
    assert.deepEqual(restoredLegacy.prompt.skillMentions, [{ name: 'shadcn', start: 0, end: 13 }])

    // Session preview collapses expanded `<skill>` blocks instead of leaking SKILL.md headers.
    assert.deepEqual(previewText(legacyExpanded), { text: '/skill:shadcn 添加按钮组件', image: false })

    // 4. Render both turns through `UserBubble` and verify chips replace raw `<skill>` / `/skill:` text.
    const newTurn = toTurn(turns[0]!, [])
    const legacyTurn = toTurn(turns[1]!, [])
    await act(async () => {
      reactRoot.render(
        createElement(TooltipProvider, null,
          createElement('div', null,
            createElement(UserBubble, { key: 'new', message: newTurn.user!, sessionId: 'session-1', turnId: newTurn.id }),
            createElement(UserBubble, { key: 'legacy', message: legacyTurn.user!, sessionId: 'session-1', turnId: legacyTurn.id })
          )
        )
      )
    })

    const chips = Array.from(container.querySelectorAll('[data-skill-mention]'))
    assert.deepEqual(chips.map((el) => el.getAttribute('data-skill-mention')), ['diffs', 'shadcn'])
    assert.deepEqual(chips.map((el) => el.textContent), ['diffs', 'shadcn'])
    const textContent = container.textContent ?? ''
    assert.equal(textContent.includes('Diffs full instructions'), false)
    assert.equal(textContent.includes('Shadcn full instructions'), false)
    assert.equal(textContent.includes('<skill'), false)
    assert.equal(textContent.includes('/skill:'), false)
    assert.equal(textContent.includes('帮我看看'), true)
    assert.equal(textContent.includes('添加按钮组件'), true)
  } finally {
    await act(async () => { reactRoot.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--skill-mention-fixture') {
  await fixture()
} else {
  test('skill mentions render as inline chips across composer metadata, user bubbles, and legacy expanded turns', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--skill-mention-fixture'])
    assert.equal(exitCode, 0, stderr || stdout)
  })
}
