/** The tab owns xterm and its shell; this panel only attaches the view and exposes Agent release. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, LoaderCircle } from 'lucide-react'
import type { TerminalAgentState } from '../../../../shared/terminal-agent'
import { attachTerminal, ensureTerminal, setTerminalActive } from '../../terminal/runtime'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { useSessionsStore } from '../../stores/sessions'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Alert, AlertDescription } from '../ui/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '../ui/alert-dialog'

export default function TerminalPanel({ terminalId, cwd, active, onFocus }: {
  terminalId: string
  cwd: string | null
  active: boolean
  onFocus: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => attachTerminal(terminalId, cwd, hostRef.current!), [terminalId, cwd])
  useLayoutEffect(() => {
    setTerminalActive(terminalId, active)
    return () => setTerminalActive(terminalId, false)
  }, [active, terminalId, cwd])
  return (
    <div data-terminal-panel className="relative flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-2 pb-1">
      <div ref={hostRef} className="min-h-0 min-w-0 flex-1 overflow-hidden" onFocusCapture={onFocus} />
      <TerminalAgentControl key={terminalId} terminalId={terminalId} cwd={cwd} />
    </div>
  )
}

function TerminalAgentControl({ terminalId, cwd }: { terminalId: string; cwd: string | null }) {
  const t = useT()
  const [state, setState] = useState<TerminalAgentState | null>(null)
  const latest = useRef<TerminalAgentState | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const lock = useRef(false)
  const alive = useRef(true)
  const [error, setError] = useState<string | null>(null)
  const running = useSessionsStore((store) => {
    const id = target ?? state?.agentSessionId
    return id ? store.runtime[id]?.isStreaming ?? false : false
  })
  useEffect(() => {
    alive.current = true
    let pushed = false
    const apply = (next: TerminalAgentState) => {
      latest.current = next
      setState(next)
    }
    const unsubscribe = api.terminal.onAgentState((next) => {
      if (next.terminalId !== terminalId) return
      pushed = true
      apply(next)
    })
    void ensureTerminal(terminalId, cwd).then(() => api.terminal.getAgentState(terminalId)).then((next) => {
      if (alive.current && !pushed) apply(next)
    }).catch((reason: unknown) => {
      if (alive.current) setError(failureMessage(reason))
    })
    return () => { alive.current = false; unsubscribe() }
  }, [terminalId, cwd])

  const release = async (stop: boolean) => {
    if (!target || lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    try {
      if (latest.current?.agentSessionId !== target) throw new Error(t('terminal.agentControlChanged'))
      if (stop) await api.abort(target)
      if (latest.current?.agentSessionId !== target) throw new Error(t('terminal.agentControlChanged'))
      await api.terminal.releaseAgent(terminalId, target)
      if (alive.current) setTarget(null)
    } catch (reason) {
      if (alive.current) setError(failureMessage(reason))
    } finally {
      lock.current = false
      if (alive.current) setPending(false)
    }
  }

  return <>
    <div className="absolute top-2 right-3 flex max-w-xs flex-col items-end gap-2">
      {state?.agentSessionId ? <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="outline" aria-label={t('terminal.releaseAgent')} onClick={() => { setError(null); setTarget(state.agentSessionId) }}><Bot /></Button>
        </TooltipTrigger>
        <TooltipContent>{t('terminal.agentControlled')}</TooltipContent>
      </Tooltip> : null}
      {error && !target ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </div>
    <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open && !lock.current) setTarget(null) }}>
      <AlertDialogContent onEscapeKeyDown={(event) => { if (lock.current) event.preventDefault() }} onCloseAutoFocus={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('terminal.releaseAgent')}</AlertDialogTitle>
          <AlertDialogDescription>{t(running ? 'terminal.releaseAgentWarning' : 'terminal.releaseAgentIdle')}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <AlertDialogFooter>
          {running
            ? <Button size="sm" variant="outline" disabled={pending} onClick={() => void release(false)}>{t('terminal.releaseDirectly')}</Button>
            : <AlertDialogCancel size="sm" disabled={pending}>{t('terminal.cancel')}</AlertDialogCancel>}
          <Button size="sm" disabled={pending} onClick={() => void release(running)}>{pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}{t(running ? 'terminal.stopAndRelease' : 'terminal.releaseControl')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
