/** Exercise the real SDK preflight without a provider request, credentials, or disk sessions. */
import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'

for (const stage of ['input', 'auth'] as const) {
  test(`host gate rejects a stopped submission after asynchronous ${stage} preflight`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pig-preflight-'))
    const entered = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    const cancellation = new AbortController()
    const stopReason = new DOMException('Stopped before dispatch', 'AbortError')
    let runStarts = 0
    let toolStarts = 0
    const settings = SettingsManager.inMemory({ compaction: { enabled: false } })
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on('input', async () => {
          if (stage === 'input') { entered.resolve(); await blocked.promise }
          return { action: 'continue' }
        })
        pi.on('before_agent_start', () => { runStarts++ })
        pi.on('tool_execution_start', () => { toolStarts++ })
      }]
    })
    let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined
    try {
      await loader.reload()
      const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false })
      const model = runtime.getModels()[0]!
      const created = await createAgentSession({
        cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
        sessionManager: SessionManager.inMemory(root), modelRuntime: runtime, model, tools: []
      })
      session = created.session
      await session.bindExtensions({ mode: 'rpc', onError: error => { throw new Error(error.error) } })
      const configured = spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(stage === 'input')
      const auth = spyOn(runtime, 'checkAuth').mockImplementation(async () => {
        entered.resolve(); await blocked.promise
        return { type: 'api_key' }
      })
      const stream = spyOn(runtime, 'streamSimple').mockImplementation(() => { throw new Error('Unexpected provider request') })
      try {
        const work = session.prompt('Must not dispatch after cancellation', {
          expandPromptTemplates: false,
          beforeStart: () => cancellation.signal.throwIfAborted()
        })
        const outcome = work.then(() => ({ error: undefined }), error => ({ error }))
        await entered.promise
        // SDK abort alone sees an idle session here; the host gate must invalidate the pending input.
        cancellation.abort(stopReason)
        await session.abort()
        blocked.resolve()
        expect((await outcome).error).toBe(stopReason)
        expect(runStarts).toBe(0)
        expect(toolStarts).toBe(0)
        expect(stream).not.toHaveBeenCalled()
        expect(session.isIdle).toBe(true)
        expect(session.sessionManager.getEntries().some(entry => entry.type === 'message')).toBe(false)
      } finally {
        stream.mockRestore(); auth.mockRestore(); configured.mockRestore()
      }
    } finally {
      blocked.resolve()
      session?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}
