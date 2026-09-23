import { ArrowUp, Square } from 'lucide-react'
import type { SessionModelInfo, ThinkingLevel } from '../../ipc/api'
import { useSettingsStore } from '../../stores/settings'
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { InputGroupAddon, InputGroupButton } from '../ui/input-group'
import { SessionTreeButton } from '../SessionTreeDialog'
import { ContextUsageButton } from './ContextUsageButton'
import { ModelPicker, ThinkingPicker } from './ModelControls'
import { useModelControls } from './useModelControls'

const EMPTY_MODELS: SessionModelInfo[] = []
const EMPTY_LEVELS: ThinkingLevel[] = ['off']
function SessionContextUsage({ sessionId }: { sessionId: string | null }) {
  const usage = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.contextUsage ?? null) : null)
  const tokens = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.tokens ?? null) : null)
  const tokensError = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.tokensError ?? null) : null)
  const loadTokenStats = useSessionsStore((s) => s.loadTokenStats)
  return (
    <ContextUsageButton
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
  hasDraft,
  isDraftSession,
  onSend,
  onAbort
}: {
  sessionId: string | null
  isStreaming: boolean
  hasDraft: boolean
  isDraftSession: boolean
  onSend: () => Promise<void>
  onAbort: () => Promise<void>
}) {
  const t = useT()
  const sessionModel = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.model ?? null) : null)
  const sessionModels = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.models ?? EMPTY_MODELS) : EMPTY_MODELS)
  const sessionThinkingLevel = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.thinkingLevel ?? 'off') : 'off')
  const sessionThinkingLevels = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.thinkingLevels ?? EMPTY_LEVELS) : EMPTY_LEVELS)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const defaultThinkingLevel = useSettingsStore((s) => s.defaultThinkingLevel)
  const model = sessionId ? sessionModel : defaultModel
  const models = sessionId ? sessionModels : (defaultModel ? [defaultModel] : EMPTY_MODELS)
  const thinkingLevel = sessionId ? sessionThinkingLevel : (defaultThinkingLevel ?? 'off')
  const thinkingLevels = sessionId ? sessionThinkingLevels : [thinkingLevel]
  const actions = useModelControls(sessionId)

  return (
    <InputGroupAddon align="block-end" className="shrink-0 justify-between px-2.5 pb-2.5">
      <div className="flex min-w-0 items-center gap-1">
        <ModelPicker key={`model-${sessionId}`} sessionId={sessionId} model={model} models={models} actions={actions} disabled={!sessionId || actions.pending} />
        <ThinkingPicker
          sessionId={sessionId}
          key={`thinking-${sessionId}`}
          thinkingLevel={thinkingLevel}
          thinkingLevels={thinkingLevels}
          actions={actions}
          disabled={!sessionId || actions.pending || thinkingLevels.length <= 1}
        />
        <SessionTreeButton disabled={!sessionId || isDraftSession || isStreaming} />
      </div>
      <div className="flex items-center gap-1.5">
        <SessionContextUsage sessionId={sessionId} />
        {isStreaming && !hasDraft ? (
          <InputGroupButton
            size="icon-sm"
            variant="secondary"
            className="size-7 rounded-full [&_svg]:fill-current [&_svg:not([class*='size-'])]:size-2.5"
            aria-label={t('composer.pause')}
            onClick={() => void onAbort()}
          >
            <Square />
          </InputGroupButton>
        ) : (
          <InputGroupButton
            size="icon-sm"
            variant="default"
            className="size-7 rounded-full [&_svg:not([class*='size-'])]:size-3.5"
            aria-label={isStreaming ? t('composer.queue') : t('composer.send')}
            disabled={!hasDraft || !sessionId}
            onClick={() => void onSend()}
          >
            <ArrowUp />
          </InputGroupButton>
        )}
      </div>
    </InputGroupAddon>
  )
}
