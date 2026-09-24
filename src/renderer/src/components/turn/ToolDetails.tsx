import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, FileCode2 } from 'lucide-react'
import type { BashExecutionMessage } from '../../pi/types'
import { resultText, toolStepLabel, type ToolStep } from '../../chat/turns'
import { langFromPath } from '../../lib/highlight'
import { hideScroll } from '../../lib/utils'
import { bashCodeSurface, codeSurface, HighlightedCode } from '../HighlightedCode'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Separator } from '../ui/separator'
import { Chevron, disclosureButton, VerbLabel } from './ProcessChrome'
import { useT } from '../../hooks/useT'
import { editList, splitReadOutput, toolClusterLabel, toolInput } from './tool-output'

const EditDiffBody = lazy(() => import('../diff/EditDiffBody'))

const panelCell =
  `max-h-60 overflow-auto px-3 py-2 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-muted-foreground ${hideScroll}`

function CodePanel({
  path,
  code,
  notice,
  fileListing = false
}: {
  path: string
  code: string
  notice?: string
  fileListing?: boolean
}) {
  const t = useT()
  const copyTimer = useRef<number>(undefined)
  const [copied, setCopied] = useState(false)
  const filename = path.split(/[/\\]/).pop() || path || t('common.file')

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`overflow-hidden ${codeSurface}`}>
      {fileListing ? (
        <div className="flex h-10 items-center gap-2 border-b border-code-border px-3 text-xs">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono" title={path}>{filename}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-mr-1 text-muted-foreground hover:text-foreground"
            aria-label={copied ? t('common.copied') : t('tool.copyCode')}
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
        </div>
      ) : null}
      <HighlightedCode code={code} lang={langFromPath(path)} variant="file" fileListing={fileListing} notice={notice} />
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

function BashToolPanel({ command, output }: { command: string; output?: string }) {
  const t = useT()
  const surface = `${bashCodeSurface} max-h-60 overflow-auto font-mono text-xs leading-snug ${hideScroll}`
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0">
        <div className="mb-1 text-xs text-muted-foreground">{t('tool.command')}</div>
        <HighlightedCode code={command} lang="bash" variant="command" />
      </div>
      {output ? (
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">{t('tool.output')}</div>
          <pre className={`${surface} whitespace-pre-wrap break-words px-3 py-2`}>{output}</pre>
        </div>
      ) : null}
    </div>
  )
}

export function ToolRow({ step }: { step: ToolStep }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const failed = !!step.result?.isError
  const edits = useMemo(() => (step.name === 'edit' ? editList(step.args) : []), [step])
  const path = typeof step.args.path === 'string' ? step.args.path : ''
  const writeCode = step.name === 'write' && typeof step.args.content === 'string' ? step.args.content : ''
  const bashCommand = step.name === 'bash' && typeof step.args.command === 'string' ? step.args.command : ''
  const read = step.name === 'read' && !failed ? splitReadOutput(resultText(step.result)) : undefined
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={toolStepLabel(step, t)} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        {step.name === 'bash' && bashCommand ? (
          <BashToolPanel command={bashCommand} output={resultText(step.result)} />
        ) : read?.code ? (
          <CodePanel path={path} code={read.code} notice={read.notice} fileListing />
        ) : writeCode && !failed ? (
          <CodePanel path={path} code={writeCode} fileListing />
        ) : edits.length > 0 ? (
          <Suspense fallback={<div className="px-3 py-2 text-xs text-muted-foreground">{t('tool.rendering')}</div>}>
            <EditDiffBody path={path} edits={edits} />
          </Suspense>
        ) : (
          <ToolPanel input={toolInput(step)} output={resultText(step.result)} />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function BashRow({ message }: { message: BashExecutionMessage }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={t('tool.run', { command: message.command })} failed={failed} />
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
  const t = useT()
  const [open, setOpen] = useState(false)
  if (steps.length === 1) return <ToolRow step={steps[0]} />
  const failed = steps.some((step) => !!step.result?.isError)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={toolClusterLabel(steps, t)} failed={failed} />
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
  const t = useT()
  const [open, setOpen] = useState(false)
  if (messages.length === 1) return <BashRow message={messages[0]} />
  const failed = messages.some((message) => message.cancelled || (message.exitCode ?? 0) !== 0)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={t('tool.runMany', { n: messages.length })} failed={failed} />
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
