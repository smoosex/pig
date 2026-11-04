/** Ephemeral Review navigation progress, outside Pi messages and turn history. */
import { ThinkingOrb } from 'thinking-orbs'
import { chatColumn } from '../../chat/layout'
import { useT } from '../../hooks/useT'
import { useDarkMode } from '../../lib/useDarkMode'
import { cn } from '../../lib/utils'
import { useSystemUIStore } from '../../stores/system-ui'
import { Marker, MarkerContent } from '../ui/marker'
import { statusMarker } from '../turn/ProcessChrome'

export function ReviewReturnProgress({ sessionId }: { sessionId: string }) {
  const t = useT()
  const dark = useDarkMode()
  const phase = useSystemUIStore((state) => state.reviewReturnPhases[sessionId])
  if (!phase) return null
  return (
    <div data-review-return-progress={phase} role="status" className={cn(chatColumn, 'py-3')}>
      <Marker className={statusMarker}>
        <ThinkingOrb state="solving" size={20} theme={dark ? 'dark' : 'light'} aria-hidden className="shrink-0" />
        <MarkerContent>{t(phase === 'summarizing' ? 'reviewUI.summarizingProgress' : 'reviewUI.returningProgress')}</MarkerContent>
      </Marker>
    </div>
  )
}
