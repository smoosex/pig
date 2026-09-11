import { useState } from 'react'
import type { CustomMessage, TextContent } from '../../pi/types'
import { formatElapsed } from '../../chat/turns'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Chevron, disclosureButton, pre, Rail, StackedIcons } from './ProcessChrome'

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

export function ThinkingBlock({ text, durationMs }: { text: string; durationMs: number }) {
  const [open, setOpen] = useState(false)
  const body = stripThoughtHeading(text)
  const title = durationMs > 0 ? `已思考 ${formatElapsed(durationMs)}` : '思考'
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={cn(disclosureButton, 'w-full')}>
          <StackedIcons kinds={['thinking']} />
          <span className="min-w-0 flex-1 truncate text-left">{title}</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {body ? (
          <Rail>
            <pre className={cn(pre, 'mt-0 text-muted-foreground')}>{body}</pre>
          </Rail>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ThinkingLine({ text, durationMs }: { text: string; durationMs: number }) {
  const [open, setOpen] = useState(false)
  const body = stripThoughtHeading(text)
  const title = durationMs > 0 ? `已思考 ${formatElapsed(durationMs)}` : '思考'
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <span className="min-w-0 flex-1 truncate text-left">{title}</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        {body ? (
          <pre className={cn(pre, 'mt-0 ml-2.5 border-l border-border px-3 py-1 text-muted-foreground')}>
            {body}
          </pre>
        ) : null}
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
