import { useMemo, useState } from 'react'
import { ArrowBigUpDash, LoaderCircle } from 'lucide-react'
import { chatColumn } from '../chat/layout'
import { relativeTime } from '../lib/relative-time'
import { useSessionsStore, type SessionMeta } from '../stores/sessions'
import { sessionTitle } from '../stores/sessions/session-title'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { SessionSizeDots } from './SessionSizeDots'

export function ProjectSessionHome({ cwd }: { cwd: string }) {
  const projects = useSessionsStore((state) => state.projects)
  const openExisting = useSessionsStore((state) => state.openExisting)
  const draftError = useSessionsStore((state) => state.draftSessionErrorByCwd[cwd])
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sessions = useMemo(() => {
    for (const project of projects) {
      const worktree = project.worktrees?.find((item) => item.cwd === cwd)
      if (worktree) return worktree.sessions.slice(0, 5)
      if (!project.worktrees && project.cwd === cwd) return project.sessions.slice(0, 5)
    }
    return []
  }, [cwd, projects])

  const open = async (session: SessionMeta) => {
    if (pending) return
    setPending(session.id)
    setError(null)
    try {
      await openExisting(session, 'project')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  if (sessions.length === 0 && !draftError) return <div className="min-h-0 flex-1" />

  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className={`${chatColumn} flex flex-col gap-2 pt-4 pb-8`}>
        {sessions.length > 0 ? (
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-xs text-muted-foreground">最近</span>
            <Separator className="min-w-0 flex-1" />
          </div>
        ) : null}
        <div className="flex flex-col gap-1 px-4">
          {sessions.map((session) => (
            <Button
              key={session.id}
              type="button"
              variant="ghost"
              className="h-10 w-full justify-start gap-3 px-3 text-xs font-normal"
              disabled={pending !== null}
              aria-busy={pending === session.id}
              onClick={() => void open(session)}
            >
              {pending === session.id ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <ArrowBigUpDash data-icon="inline-start" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{sessionTitle(session)}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
                  {relativeTime(session.modified)}
                </span>
                <SessionSizeDots size={session.size} />
              </span>
            </Button>
          ))}
        </div>
        {draftError || error ? (
          <p role="alert" className="px-3 text-sm text-destructive">{draftError || error}</p>
        ) : null}
      </div>
    </div>
  )
}
