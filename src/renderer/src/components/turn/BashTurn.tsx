import { useEffect, useState } from 'react'
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleX,
  Copy,
  LoaderCircle,
  Square,
  SquareTerminal,
} from 'lucide-react'
import type { Turn } from '../../chat/turns'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { codeSurface, HighlightedCode } from '../HighlightedCode'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader } from '../ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Separator } from '../ui/separator'

/** Direct shell executions are conversation entries, not assistant tool calls or answers. */
export function BashTurn({
  turn,
  onNeedProcess,
  onAbortBash,
}: {
  turn: Turn
  onNeedProcess?: (turnId: string) => Promise<void>
  onAbortBash?: () => Promise<void>
}) {
  const t = useT()
  const [open, setOpen] = useState(turn.bashRunning || turn.process.length > 0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bash = turn.bash!
  const message = turn.process.find((item) => item.kind === 'bash')
  const output = message?.kind === 'bash' ? message.message.output : undefined
  const commandCopy = useCopyFeedback(bash.command)
  const outputCopy = useCopyFeedback(output ?? '')
  const copiedClass = (copied: boolean) => cn(copied && 'text-success hover:text-success')
  const success = !turn.bashRunning && !bash.cancelled && bash.exitCode === 0
  const failed =
    !turn.bashRunning && !bash.cancelled && bash.exitCode != null && bash.exitCode !== 0
  const status = turn.bashRunning
    ? t('turn.bashRunning')
    : bash.cancelled
      ? t('turn.bashCancelled')
      : bash.exitCode != null
        ? t('turn.bashExit', { code: bash.exitCode })
        : ''
  const StatusIcon = turn.bashRunning
    ? LoaderCircle
    : success
      ? CheckCircle2
      : bash.cancelled
        ? Ban
        : CircleX

  useEffect(() => {
    if (turn.bashRunning) setOpen(true)
  }, [turn.bashRunning])

  async function stop() {
    try {
      await onAbortBash?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setOpen(true)
    }
  }

  async function toggle(next: boolean) {
    setOpen(next)
    if (next && !message && onNeedProcess && turn.id && !turn.id.startsWith('live:')) {
      setLoading(true)
      setError(null)
      try {
        await onNeedProcess(turn.id)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <Card size="sm" className="mb-4 min-w-0 gap-0 bg-secondary py-0">
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          void toggle(next)
        }}
      >
        <CardHeader className="flex flex-row flex-wrap items-center gap-2 pt-2 pb-1">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              className="min-w-0 flex-1 justify-start gap-2 font-mono text-xs"
              aria-label={open ? t('turn.bashHideOutput') : t('turn.bashShowOutput')}
            >
              <SquareTerminal aria-hidden="true" />
              <span className="min-w-0 truncate text-left" title={bash.command}>
                $ {bash.command}
              </span>
            </Button>
          </CollapsibleTrigger>
          {status ? (
            <Badge
              variant={failed ? 'destructive' : 'secondary'}
              aria-live="polite"
              className={cn(
                success && 'bg-success-background text-success',
                turn.bashRunning && 'bg-info-background text-info',
              )}
            >
              <StatusIcon
                className={cn(turn.bashRunning && 'animate-spin')}
                data-icon="inline-start"
                aria-hidden="true"
              />
              {status}
            </Badge>
          ) : null}
          {turn.bashRunning ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('composer.stopBash')}
              onClick={() => void stop()}
            >
              <Square />
            </Button>
          ) : null}
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={loading}
              aria-label={open ? t('turn.bashHideOutput') : t('turn.bashShowOutput')}
            >
              <ChevronDown
                className={cn('transition-transform', !open && '-rotate-90')}
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <Separator />
          <CardContent className="flex min-w-0 flex-col gap-2 pt-0.75 pb-1">
            <div className="flex items-center justify-between gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <span>{t('tool.command')}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={commandCopy.copied ? t('common.copied') : t('turn.bashCopyCommand')}
                className={copiedClass(commandCopy.copied)}
                onClick={() => void commandCopy.copy()}
              >
                {commandCopy.copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <HighlightedCode code={bash.command} lang="bash" variant="terminal" />
          </CardContent>
          <Separator />
          <CardContent className="flex min-w-0 flex-col gap-2 pt-0.75 pb-2">
            <div className="flex items-center justify-between gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <span>{t('tool.output')}</span>
              {output ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={outputCopy.copied ? t('common.copied') : t('turn.bashCopyOutput')}
                  className={copiedClass(outputCopy.copied)}
                  onClick={() => void outputCopy.copy()}
                >
                  {outputCopy.copied ? <Check /> : <Copy />}
                </Button>
              ) : null}
            </div>
            <pre
              className={cn(
                codeSurface,
                hideScroll,
                'max-h-60 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-snug',
              )}
            >
              {output ||
                (loading
                  ? t('turn.loading')
                  : turn.bashRunning
                    ? t('turn.bashRunning')
                    : t('turn.bashNoOutput'))}
            </pre>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
