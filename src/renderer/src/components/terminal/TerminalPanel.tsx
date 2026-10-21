/** A terminal tab's view; the xterm instance and its shell belong to the tab (see terminal/runtime). */
import { useLayoutEffect, useRef } from 'react'
import { attachTerminal, setTerminalActive } from '../../terminal/runtime'

export default function TerminalPanel({ terminalId, cwd, active, onFocus }: {
  terminalId: string
  /** The worktree to start in; null for terminals opened outside a project, which start at home. */
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
    <div data-terminal-panel className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-2 pb-1" onFocusCapture={onFocus}>
      <div ref={hostRef} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
    </div>
  )
}
