import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, FileCode2 } from 'lucide-react'
import type { BashExecutionMessage } from '../../pi/types'
import { resultText, toolStepLabel, type ToolStep } from '../../chat/turns'
import { langFromPath, useHighlightHtml } from '../../lib/highlight'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Separator } from '../ui/separator'
import { Chevron, disclosureButton, hideScroll, VerbLabel } from './ProcessChrome'
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
  const ref = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<number>(undefined)
  const [copied, setCopied] = useState(false)
  const html = useHighlightHtml(code, langFromPath(path), ref)
  const filename = path.split(/[/\\]/).pop() || path || '文件'

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="overflow-hidden rounded-lg border border-code-border bg-code-background text-code-foreground">
      {fileListing ? (
        <div className="flex h-10 items-center gap-2 border-b border-code-border px-3 text-xs">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono" title={path}>{filename}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-mr-1 text-muted-foreground hover:text-foreground"
            aria-label={copied ? '已复制' : '复制代码'}
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
      ) : null}
      <div
        ref={ref}
        className="max-h-80 overflow-auto font-mono text-xs leading-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {html ? (
          <div
            className={fileListing
              ? '[&_code]:[counter-reset:line] [&_.line]:before:mr-3 [&_.line]:before:inline-block [&_.line]:before:w-7 [&_.line]:before:border-r [&_.line]:before:border-code-border [&_.line]:before:pr-2 [&_.line]:before:text-right [&_.line]:before:text-muted-foreground [&_.line]:before:content-[counter(line)] [&_.line]:before:[counter-increment:line] [&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:px-3 [&_pre]:py-3 [&_pre]:text-xs [&_pre]:leading-4'
              : '[&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-4'}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : fileListing ? (
          <pre className="m-0 py-3 whitespace-pre">
            {code.split('\n').map((line, index) => (
              <span key={index} className="block min-w-max px-3">
                <span className="mr-3 inline-block w-7 select-none border-r border-code-border pr-2 text-right text-muted-foreground">
                  {index + 1}
                </span>
                {line || '\u200b'}
              </span>
            ))}
          </pre>
        ) : (
          <pre className="m-0 whitespace-pre p-3">{code}</pre>
        )}
        {notice ? <div className="px-3 pb-3 text-muted-foreground">{notice}</div> : null}
      </div>
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
  const edits = useMemo(() => (step.name === 'edit' ? editList(step.args) : []), [step])
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
          <CodePanel path={path} code={read.code} notice={read.notice} fileListing />
        ) : writeCode && !failed ? (
          <CodePanel path={path} code={writeCode} fileListing />
        ) : edits.length > 0 ? (
          <Suspense fallback={<div className="px-3 py-2 text-xs text-muted-foreground">正在渲染…</div>}>
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
