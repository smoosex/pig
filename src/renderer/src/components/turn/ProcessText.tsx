import { useEffect, useRef, useState } from 'react'
import type { CustomMessage, TextContent } from '../../pi/types'
import { formatElapsed } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Marker, MarkerContent } from '../ui/marker'
import { Chevron, disclosureButton, pre, Rail, StackedIcons, statusMarker } from './ProcessChrome'

export function stripThoughtHeading(text: string): string {
  return text.replace(/^(Thought for \d+s|已?思考了?\s*\d+\s*(秒|s)?)\s*\n+/i, '').trim()
}

export function ProcessDisclosure({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <Chevron open={open} />
          <span>{title}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className={cn(pre, 'px-2 pb-2 text-muted-foreground')}>{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * One thinking block. Live rows track the newest line of reasoning until the
 * reader scrolls away from it; settled rows only render once expanded.
 */
export function ThinkingRow({
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
      ? t('turn.thoughtFor', { duration: formatElapsed(durationMs, t) })
      : t('turn.thought')

  useEffect(() => {
    if (!open || !live || !following.current) return
    const node = bodyRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [open, live, body])

  const label = (
    <span className={cn('min-w-0 flex-1 truncate text-left', live && streaming && 'shimmer shimmer-once')}>{title}</span>
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
}

export function CustomProcess({ message }: { message: CustomMessage }) {
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
}
