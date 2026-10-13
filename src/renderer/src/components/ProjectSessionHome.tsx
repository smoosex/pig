import { useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { chatColumn } from '../chat/layout'
import { useT } from '../hooks/useT'
import { relativeTime } from '../lib/relative-time'
import { withSessionForks } from '../../../shared/session-lineage'
import { useSessionsStore, type SessionMeta } from '../stores/sessions'
import { sessionTitle } from '../stores/sessions/session-title'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { SidebarHoverHighlight } from './sidebar/SidebarHoverHighlight'
import { SessionSizeDots } from './SessionSizeDots'
import { SessionForkIcon } from './SessionForkIcon'

export function ProjectSessionHome({ cwd }: { cwd: string }) {
  const t = useT()
  const projects = useSessionsStore((state) => state.projects)
  const openExisting = useSessionsStore((state) => state.openExisting)
  const draftError = useSessionsStore((state) => state.draftSessionErrorByCwd[cwd])
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sessions = useMemo(() => {
    for (const project of projects) {
      const worktree = project.worktrees?.find((item) => item.cwd === cwd)
      const metas = worktree?.sessions ?? (!project.worktrees && project.cwd === cwd ? project.sessions : undefined)
      if (!metas) continue
      // Cap newest-first candidates before threading; deep ancestry must not displace recent sessions.
      return withSessionForks(metas.slice(0, 5))
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
            <span className="shrink-0 text-xs text-muted-foreground">{t('sessions.recent')}</span>
            <Separator className="min-w-0 flex-1" />
          </div>
        ) : null}
        <SidebarHoverHighlight
          className="flex flex-col gap-1 px-4"
          highlightClassName="bg-muted dark:bg-muted/50"
        >
          {sessions.map((row) => (
            <Button
              key={row.id}
              type="button"
              variant="ghost"
              data-sidebar-hover-row
              className="relative h-10 w-full justify-start gap-3 px-3 text-xs font-normal !bg-transparent"
              disabled={pending !== null}
              aria-busy={pending === row.id}
              onClick={() => void open(row)}
            >
              {pending === row.id ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : null}
              {row.forkedFrom ? <SessionForkIcon /> : null}
              <span className="min-w-0 flex-1 truncate text-left">{sessionTitle(row)}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
                  {relativeTime(row.modified, t)}
                </span>
                <SessionSizeDots size={row.size} />
              </span>
            </Button>
          ))}
        </SidebarHoverHighlight>
        {draftError || error ? (
          <p role="alert" className="px-3 text-sm text-destructive">{draftError || error}</p>
        ) : null}
      </div>
    </div>
  )
}
