import { useState } from 'react'
import type { BashExecutionMessage } from '../../pi/types'
import { resultText, toolStepLabel, type ToolStep } from '../../chat/turns'
import { langFromPath, useHighlightHtml } from '../../lib/highlight'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Separator } from '../ui/separator'
import { Chevron, disclosureButton, hideScroll, VerbLabel } from './ProcessChrome'
import { editList, hunkRows, splitReadOutput, toolClusterLabel, toolInput } from './tool-output'

const panelCell =
  `max-h-60 overflow-auto px-3 py-2 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-muted-foreground ${hideScroll}`

function EditDiff({ edits }: { edits: { oldText: string; newText: string }[] }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-code-border bg-code-background font-mono text-code-foreground text-xs leading-snug [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {edits.map((edit, i) => (
        <div key={i}>
          <div className="px-3 py-1.5 text-muted-foreground">{`// — edit ${i + 1} —`}</div>
          {hunkRows(edit.oldText, edit.newText).map((row, j) => (
            <div
              key={j}
              className={cn(
                'min-h-5 whitespace-pre px-3',
                row.type === 'del' && 'bg-destructive/15 text-destructive',
                row.type === 'add' && 'bg-success/15 text-success',
                row.type === 'ctx' && 'text-muted-foreground'
              )}
            >
              {`${row.type === 'del' ? '-' : row.type === 'add' ? '+' : ' '} ${row.text}`}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function CodePanel({ path, code, notice }: { path: string; code: string; notice?: string }) {
  const html = useHighlightHtml(code, langFromPath(path))
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-code-border bg-code-background font-mono text-code-foreground text-xs leading-snug [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {html ? (
        <div
          className="[&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-snug"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 whitespace-pre p-3">{code}</pre>
      )}
      {notice ? <div className="px-3 pb-3 text-muted-foreground">{notice}</div> : null}
    </div>
  )
}

function ToolPanel({ input, output }: { input?: string; output?: string }) {
  if (!input && !output) return null
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {input ? <pre className={panelCell}>{input}</pre> : null}
      {input && output ? <Separator /> : null}
      {output ? <pre className={panelCell}>{output}</pre> : null}
    </div>
  )
}

export function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  const failed = !!step.result?.isError
  const edits = step.name === 'edit' ? editList(step.args) : []
  const path = typeof step.args.path === 'string' ? step.args.path : ''
  const writeCode = step.name === 'write' && typeof step.args.content === 'string' ? step.args.content : ''
  const read = step.name === 'read' && !failed ? splitReadOutput(resultText(step.result)) : undefined
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={toolStepLabel(step)} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        {read?.code ? (
          <CodePanel path={path} code={read.code} notice={read.notice} />
        ) : writeCode && !failed ? (
          <CodePanel path={path} code={writeCode} />
        ) : edits.length > 0 ? (
          <EditDiff edits={edits} />
        ) : (
          <ToolPanel input={toolInput(step)} output={resultText(step.result)} />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function BashRow({ message }: { message: BashExecutionMessage }) {
  const [open, setOpen] = useState(false)
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={`执行 ${message.command}`} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        <ToolPanel input={`$ ${message.command}`} output={message.output} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ToolCluster({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 1) return <ToolRow step={steps[0]} />
  const failed = steps.some((step) => !!step.result?.isError)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={toolClusterLabel(steps)} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        <div className="flex min-w-0 flex-col">
          {steps.map((step) => (
            <ToolRow key={step.id} step={step} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function BashCluster({ messages }: { messages: BashExecutionMessage[] }) {
  const [open, setOpen] = useState(false)
  if (messages.length === 1) return <BashRow message={messages[0]} />
  const failed = messages.some((message) => message.cancelled || (message.exitCode ?? 0) !== 0)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={`执行 ${messages.length} 个命令`} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        <div className="flex min-w-0 flex-col">
          {messages.map((message, i) => (
            <BashRow key={i} message={message} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
