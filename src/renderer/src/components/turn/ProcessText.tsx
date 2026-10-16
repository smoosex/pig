import { memo, useEffect, useRef, useState } from 'react'
import { SUBAGENT_RESULT_TYPE } from '../../../../shared/api'
import type { CustomMessage, TextContent } from '../../pi/types'
import { formatElapsed } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Marker, MarkerContent } from '../ui/marker'
import { SubagentResultNotice } from '../subagents/SubagentLinks'
import { Chevron, disclosureButton, pre, Rail, StackedIcons, statusMarker } from './ProcessChrome'

export function stripThoughtHeading(text: string): string {
  return text.replace(/^(Thought for \d+s|已?思考了?\s*\d+\s*(秒|s)?)\s*\n+/i, '').trim()
}

/**
 * One thinking block. Live rows track the newest line of reasoning until the reader scrolls away
 * from it; settled rows only render once expanded.
 *
 * Memoized on the rendered text and its timing: a live turn re-renders every frame, and only the
 * row currently receiving reasoning deltas can change. `text` is compared by value because the SDK
 * mutates the block objects it shares with the store, so a block reference would look unchanged
 * while its contents moved.
 */
export const ThinkingRow = memo(function ThinkingRow({
  text,
  durationMs = 0,
  stacked,
  live,
  streaming
}: {
  text: string
  durationMs?: number
  stacked?: boolean
  live?: boolean
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  const t = useT()
  const body = stripThoughtHeading(text)
  const title = live
    ? t('turn.thinkingNow')
    : durationMs > 0
      ? t('turn.thoughtFor', { duration: formatElapsed(Math.max(1000, durationMs), t) })
      : t('turn.thought')

  useEffect(() => {
    if (!open || !live || !following.current) return
    const node = bodyRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [open, live, body])

  const label = (
    <span className={cn('min-w-0 flex-1 truncate text-left', live && streaming && 'shimmer')}>{title}</span>
  )

  if (live && !body) {
    return (
      <Marker className={statusMarker}>
        {stacked ? <StackedIcons kinds={['thinking']} /> : null}
        <MarkerContent className="flex-1 truncate">{label}</MarkerContent>
      </Marker>
    )
  }

  const stream = (
    <pre
      ref={bodyRef}
      onScroll={(event) => {
        const node = event.currentTarget
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
      }}
      className={cn(pre, 'mt-0 text-muted-foreground', !stacked && 'ml-2.5 border-l border-border px-3 py-1')}
    >
      {body}
    </pre>
  )
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        if (next) following.current = true
        setOpen(next)
      }}
      className="min-w-0"
    >
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={cn(disclosureButton, stacked && 'w-full')}>
          {stacked ? <StackedIcons kinds={['thinking']} /> : null}
          {label}
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className={stacked ? undefined : 'px-1 pt-1'}>
        {body ? (stacked ? <Rail>{stream}</Rail> : stream) : null}
      </CollapsibleContent>
    </Collapsible>
  )
})

export const CustomProcess = memo(function CustomProcess({ message }: { message: CustomMessage }) {
  if (message.customType === SUBAGENT_RESULT_TYPE) return <SubagentResultNotice message={message} />
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === 'text')
          .map((b) => b.text)
          .join('')
  return (
    <div className="text-sm">
      <div className="font-medium text-muted-foreground">{message.customType}</div>
      {text ? <p className="mt-1 whitespace-pre-wrap">{text}</p> : null}
    </div>
  )
})
