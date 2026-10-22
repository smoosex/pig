/**
 * Pig's SDK patch lets a `preamble` section replace Pi's identity line while the default tools,
 * rules and docs sections are still generated, recorded as an ordinary section patch.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'

test('a preamble section replaces only the identity line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-preamble-'))
  try {
    let identity: string | undefined
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on('before_agent_start', (event) => {
          if (identity) event.systemPromptOptions.sections.preamble = identity
        })
      }]
    })
    await loader.reload()
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
    })
    await session.bindExtensions({ mode: 'rpc', onError: (error) => { throw new Error(error.error) } })
    const prepare = async () => {
      const run = session as unknown as { _prepareRun(trigger: unknown): Promise<{ role: string; sections?: Record<string, string | null> }[]> }
      const messages = await run._prepareRun({ messageType: 'user', prompt: 'hi', images: [] })
      return messages.find((message) => message.role === 'system')?.sections
    }
    const initial = await prepare()
    assert.match(initial?.preamble ?? '', /^You are an expert coding assistant/)
    // Seed the transcript so the next run diffs against the recorded sections.
    session.agent.state.messages.push({ role: 'system', content: '', sections: initial as Record<string, string>, timestamp: 1 } as never)
    identity = 'You are Susan. A loyal familiar.'
    const patch = await prepare()
    assert.deepEqual(patch, { preamble: 'You are Susan. A loyal familiar.' }, 'only the identity line changes; tools, rules and docs stay')
    for (const name of ['tools', 'rules', 'docs']) assert.ok(initial?.[name], `${name} is still generated`)
    session.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
