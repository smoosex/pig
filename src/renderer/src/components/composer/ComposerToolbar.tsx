import { useEffect, useState } from 'react'
import { ArrowUp, Square, SquareTerminal } from 'lucide-react'
import { api } from '../../ipc/api'
import type { ThinkingLevel } from '../../ipc/api'
import { useSettingsStore } from '../../stores/settings'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { InputGroupAddon, InputGroupButton } from '../ui/input-group'
import { SessionTreeButton } from '../SessionTreeDialog'
import { ContextUsageButton } from './ContextUsageButton'
import { ModelPicker, ThinkingPicker } from './ModelControls'
import { useModelControls } from './useModelControls'

const EMPTY_LEVELS: ThinkingLevel[] = ['off']
function SessionContextUsage({ sessionId }: { sessionId: string | null }) {
  const projectCwd = useSessionsStore((s) => s.currentProjectCwd)
  const [memoryEnabled, setMemoryEnabled] = useState(false)
  useEffect(() => {
    let active = true
    if (!sessionId || !projectCwd) return
    const load = () => { void api.isMemoryPluginEnabled().then((enabled) => {
      if (active) setMemoryEnabled(enabled)
    }, () => { if (active) setMemoryEnabled(false) }) }
    load()
    const off = api.onPluginsChanged(load)
    return () => { active = false; off() }
  }, [sessionId, projectCwd])
  const usage = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.contextUsage ?? null) : null)
  const tokens = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.tokens ?? null) : null)
  const tokensError = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.tokensError ?? null) : null)
  const loadTokenStats = useSessionsStore((s) => s.loadTokenStats)
  return (
    <ContextUsageButton
      sessionId={sessionId}
      memoryAvailable={!!projectCwd && memoryEnabled}
      usage={usage}
      tokens={tokens}
      error={tokensError}
      onOpen={() => { if (sessionId) void loadTokenStats(sessionId) }}
      disabled={!sessionId}
    />
  )
}

export function ComposerToolbar({
  sessionId,
  isStreaming,
  bashMode,
  canRunBash,
  hasDraft,
  isDraftSession,
  inputDisabled,
  onSend,
  onAbort
}: {
  sessionId: string | null
  isStreaming: boolean
  bashMode: boolean
  canRunBash: boolean
  hasDraft: boolean
  isDraftSession: boolean
  inputDisabled: boolean
  onSend: () => Promise<void>
  onAbort: () => Promise<void>
}) {
  const t = useT()
  const bashRunning = useSessionsStore((s) => sessionId ? s.runtime[sessionId]?.bashExecution != null : false)
  const sessionModel = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.model ?? null) : null)
  const sessionThinkingLevel = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.thinkingLevel ?? 'off') : 'off')
  const sessionThinkingLevels = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.thinkingLevels ?? EMPTY_LEVELS) : EMPTY_LEVELS)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const defaultThinkingLevel = useSettingsStore((s) => s.defaultThinkingLevel)
  // The catalog is the app's, not the session's: a session with no model chosen still shows every
  // provider the app knows about, which is what makes the picker usable on a fresh tab.
  const models = useModelCatalogStore((s) => s.models)
  const refreshing = useModelCatalogStore((s) => s.refreshing)
  const model = sessionId ? sessionModel : defaultModel
  const thinkingLevel = sessionId ? sessionThinkingLevel : (defaultThinkingLevel ?? 'off')
  const thinkingLevels = sessionId ? sessionThinkingLevels : [thinkingLevel]
  const actions = useModelControls(sessionId)

  return (
    <InputGroupAddon align="block-end" className="shrink-0 justify-between px-2.5 pb-2.5">
      <div className="flex min-w-0 items-center gap-1">
        {bashMode ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <SquareTerminal className="size-3.5" /> {t('composer.bashMode')}
          </span>
        ) : (
          <>
            <ModelPicker
              key={`model-${sessionId}`}
              sessionId={sessionId}
              model={model}
              models={models}
              refreshing={refreshing}
              actions={actions}
              disabled={!sessionId || actions.pending}
            />
            <ThinkingPicker
              sessionId={sessionId}
              key={`thinking-${sessionId}`}
              thinkingLevel={thinkingLevel}
              thinkingLevels={thinkingLevels}
              actions={actions}
              disabled={!sessionId || actions.pending || thinkingLevels.length <= 1}
            />
            <SessionTreeButton disabled={!sessionId || isDraftSession || isStreaming || bashRunning} />
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {!bashMode ? <SessionContextUsage sessionId={sessionId} /> : null}
        {bashRunning || (isStreaming && (!hasDraft || bashMode)) ? (
          <InputGroupButton
            size="icon-sm"
            variant="secondary"
            className="size-7 rounded-full [&_svg]:fill-current [&_svg:not([class*='size-'])]:size-2.5"
            aria-label={t(bashRunning ? 'composer.stopBash' : 'composer.pause')}
            onClick={() => void onAbort()}
          >
            <Square />
          </InputGroupButton>
        ) : (
          <InputGroupButton
            size="icon-sm"
            variant="default"
            className="size-7 rounded-full [&_svg:not([class*='size-'])]:size-3.5"
            aria-label={bashMode ? t('composer.runBash') : isStreaming ? t('composer.queue') : t('composer.send')}
            disabled={!sessionId || inputDisabled || bashRunning || (bashMode ? !canRunBash || isStreaming : !hasDraft)}
            onClick={() => void onSend()}
          >
            <ArrowUp />
          </InputGroupButton>
        )}
      </div>
    </InputGroupAddon>
  )
}
