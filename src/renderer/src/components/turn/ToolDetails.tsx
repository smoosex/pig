import { lazy, memo, Suspense, useMemo, useState } from 'react'
import { Check, Copy, FileCode2 } from 'lucide-react'
import type { BashExecutionMessage } from '../../pi/types'
import type { LiveNestedCall } from '../../chat/nested-tools'
import { resultText, toolStepLabel, type ToolStep } from '../../chat/turns'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { langFromPath } from '../../lib/highlight'
import { cn, hideScroll } from '../../lib/utils'
import { glassCodeSurface, glassCommandSurface, HighlightedCode } from '../HighlightedCode'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Separator } from '../ui/separator'
import { Chevron, disclosureButton, Rail, VerbLabel } from './ProcessChrome'
import { useT } from '../../hooks/useT'
import { editList, splitReadOutput, toolClusterLabel, toolInput } from './tool-output'
import { NestedToolCalls } from './NestedToolCalls'
import { SpawnToolBody } from '../subagents/SubagentLinks'

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
  const { copied, copy } = useCopyFeedback(code)
  const filename = path.split(/[/\\]/).pop() || path || t('common.file')

  return (
    <div className={`overflow-hidden ${glassCodeSurface}`}>
      {fileListing ? (
        <div className="flex h-10 items-center gap-2 border-b border-glass-card-border px-3 text-xs solid:border-code-border">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono" title={path}>{filename}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn('-mr-1 text-muted-foreground hover:text-foreground', copied && 'text-success hover:text-success')}
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
    <div className={cn('overflow-hidden', glassCodeSurface, 'solid:border-border solid:bg-transparent')}>
      {input ? <pre className={panelCell}>{input}</pre> : null}
      {input && output ? <Separator className="bg-glass-card-border solid:bg-border" /> : null}
      {output ? <pre className={panelCell}>{output}</pre> : null}
    </div>
  )
}

function BashToolPanel({ command, output }: { command: string; output?: string }) {
  const t = useT()
  const surface = `${glassCommandSurface} max-h-60 overflow-auto font-mono text-xs leading-snug ${hideScroll}`
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

/**
 * groupTurns rebuilds ToolStep wrappers on each delta. Arguments and results retain their source
 * snapshot references, so compare the wrapper's fields rather than its identity.
 */
export const ToolRow = memo(function ToolRow({ step, active, nestedCall }: {
  step: ToolStep
  active?: boolean
  nestedCall?: LiveNestedCall
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const failed = nestedCall?.status === 'error' || !!step.result?.isError
  const output = resultText(step.result ?? step.partialResult)
  const edits = useMemo(() => (step.name === 'edit' ? editList(step.args) : []), [step])
  const path = typeof step.args.path === 'string' ? step.args.path : ''
  const writeCode = step.name === 'write' && typeof step.args.content === 'string' ? step.args.content : ''
  const bashCommand = step.name === 'bash' && typeof step.args.command === 'string' ? step.args.command : ''
  const read = step.name === 'read' && !failed ? splitReadOutput(output) : undefined
  const nested = step.result?.nestedCalls ?? step.partialResult?.nestedCalls
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={toolStepLabel(step, t)} failed={failed} active={active && !step.result} />
          {nestedCall ? (
            <Badge variant={failed ? 'destructive' : 'secondary'}>
              {t(nestedCall.status === 'ok' ? 'mcp.success' : `mcp.${nestedCall.status}`)}
            </Badge>
          ) : null}
          {nestedCall?.durationMs !== undefined ? (
            <span className="shrink-0 text-muted-foreground">
              {t('mcp.duration', { ms: Math.round(nestedCall.durationMs) })}
            </span>
          ) : null}
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        {step.name === 'spawn' ? (
          <>
            <SpawnToolBody toolCallId={step.id} />
            {step.result ? <ToolPanel output={output} /> : null}
          </>
        ) : step.name === 'bash' && bashCommand ? (
          <BashToolPanel command={bashCommand} output={output} />
        ) : read?.code ? (
          <CodePanel path={path} code={read.code} notice={read.notice} fileListing />
        ) : writeCode && !failed ? (
          <CodePanel path={path} code={writeCode} fileListing />
        ) : edits.length > 0 ? (
          <Suspense fallback={<div className="px-3 py-2 text-xs text-muted-foreground">{t('tool.rendering')}</div>}>
            <EditDiffBody path={path} edits={edits} />
          </Suspense>
        ) : (
          <ToolPanel input={toolInput(step)} output={output} />
        )}
        {nestedCall?.argumentsBytes !== undefined ? (
          <p className="text-xs text-muted-foreground">
            {t('mcp.argumentsOmitted', { n: nestedCall.argumentsBytes })}
          </p>
        ) : null}
        {nestedCall?.error ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">
            {nestedCall.error}
          </p>
        ) : null}
        {nested ? (
          <NestedToolCalls record={nested}>
            {nested.calls.map((call) => (
              <ToolRow
                key={call.id}
                step={{ id: call.id, name: call.name, args: call.arguments ?? {} }}
                active={call.status === 'running'}
                nestedCall={call}
              />
            ))}
          </NestedToolCalls>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}, (previous, next) =>
  previous.step.id === next.step.id &&
  previous.step.name === next.step.name &&
  previous.step.args === next.step.args &&
  previous.step.result === next.step.result &&
  previous.step.partialResult === next.step.partialResult &&
  previous.active === next.active &&
  previous.nestedCall === next.nestedCall
)

export const BashRow = memo(function BashRow({ message }: { message: BashExecutionMessage }) {
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
})

export const ToolCluster = memo(function ToolCluster({ steps }: { steps: ToolStep[] }) {
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
      <CollapsibleContent>
        <Rail>
          <div className="flex min-w-0 flex-col">
            {steps.map((step) => (
              <ToolRow key={step.id} step={step} />
            ))}
          </div>
        </Rail>
      </CollapsibleContent>
    </Collapsible>
  )
})

export const BashCluster = memo(function BashCluster({ messages }: { messages: BashExecutionMessage[] }) {
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
      <CollapsibleContent>
        <Rail>
          <div className="flex min-w-0 flex-col">
            {messages.map((message, i) => (
              <BashRow key={i} message={message} />
            ))}
          </div>
        </Rail>
      </CollapsibleContent>
    </Collapsible>
  )
})
