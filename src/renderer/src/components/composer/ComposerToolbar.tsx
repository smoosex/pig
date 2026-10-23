import { useEffect, useState } from 'react'
import { ArrowUp, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../../ipc/api'
import type { ThinkingLevel } from '../../ipc/api'
import { useSettingsStore } from '../../stores/settings'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { InputGroupAddon, InputGroupButton } from '../ui/input-group'
import { SessionTreeButton } from '../SessionTreeDialog'
import { SessionCapabilitiesButton } from './SessionCapabilitiesButton'
import { ContextUsageButton } from './ContextUsageButton'
import { ProcessStatus } from './ProcessStatus'
import { ReviewStatus } from './ReviewStatus'
import { SubagentStatus } from './SubagentStatus'
import { ModelPicker, ThinkingPicker } from './ModelControls'
import { useModelControls } from './useModelControls'

const EMPTY_LEVELS: ThinkingLevel[] = ['off']
function SessionContextUsage({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const ready = useSessionsStore((s) => {
    if (!sessionId) return false
    const tab = s.openTabs.find((item) => item.id === sessionId)
    if (tab) return tab.loadState === 'ready'
    // Project draft ids precede registration; their first controls reply proves main holds them.
    return s.chatDraft?.sessionId === sessionId || (s.runtime[sessionId]?.controlsRevision ?? 0) > 0
  })
  const [memorySessionId, setMemorySessionId] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    if (!sessionId || !ready) return
    const load = () => { void api.isMemoryPluginEnabled(sessionId).then((enabled) => {
      if (active) setMemorySessionId(enabled ? sessionId : null)
    }, (failure) => {
      // Report IPC/config failures at this read-only UI boundary, not as a disabled plugin.
      if (active) toast.error(t('context.memoryFailed', {
        error: failure instanceof Error ? failure.message : String(failure)
      }))
    }) }
    load()
    const off = api.onPluginsChanged(load)
    return () => { active = false; off() }
  }, [sessionId, ready, t])
  const usage = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.contextUsage ?? null) : null)
  const tokens = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.tokens ?? null) : null)
  const tokensError = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.tokensError ?? null) : null)
  const loadTokenStats = useSessionsStore((s) => s.loadTokenStats)
  const compactBlock = useSessionsStore((s) => {
    const runtime = sessionId ? s.runtime[sessionId] : undefined
    if (!runtime) return null
    if (runtime.liveCompactions.some((mark) => mark.status === 'running')) return 'compacting'
    if (runtime.isNavigatingBranch) return 'navigating'
    // Pi's compact aborts the run in flight; a one-click button must not stop work silently.
    return runtime.isStreaming ? 'running' : null
  })
  return (
    <ContextUsageButton
      sessionId={sessionId}
      memoryAvailable={ready && memorySessionId === sessionId}
      usage={usage}
      tokens={tokens}
      error={tokensError}
      onOpen={() => { if (sessionId && ready) void loadTokenStats(sessionId) }}
      compactBlock={compactBlock}
      disabled={!ready}
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
      {/* Labels collapse on the space left beside the right-hand controls, which grow with session states. */}
      <div className="@container/composer-tools flex min-w-0 flex-1 items-center gap-1">
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
            <SessionCapabilitiesButton key={sessionId} sessionId={sessionId} busy={isStreaming || bashRunning} />
            <SessionTreeButton disabled={!sessionId || isDraftSession || isStreaming || bashRunning} />
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {/* Transient session states sit beside the context meter instead of reserving a row around the box. */}
        <ProcessStatus sessionId={sessionId} />
        <SubagentStatus sessionId={sessionId} />
        <ReviewStatus key={sessionId ?? 'none'} sessionId={sessionId} />
        {!bashMode ? <SessionContextUsage sessionId={sessionId} /> : null}
        {bashRunning || (isStreaming && (!hasDraft || bashMode)) ? (
          <InputGroupButton
            size="icon-xs"
            variant="secondary"
            className="rounded-full"
            aria-label={t(bashRunning ? 'composer.stopBash' : 'composer.pause')}
            onClick={() => void onAbort()}
          >
            <span aria-hidden className="size-2.5 rounded-xs bg-destructive bg-(image:--glass-badge-sheen) shadow-glass-badge" />
          </InputGroupButton>
        ) : (
          <InputGroupButton
            size="icon-xs"
            variant="default"
            className="rounded-full [&_svg:not([class*='size-'])]:size-3"
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
