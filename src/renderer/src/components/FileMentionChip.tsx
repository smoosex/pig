import { createContext, useContext, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { baseName } from '../../../shared/paths'
import { api, type FileMentionInfo } from '../ipc/api'
import { useT } from '../hooks/useT'
import { relativeTime } from '../lib/relative-time'
import { failureMessage } from '../lib/ipc-error'
import { cn } from '../lib/utils'
import { useSessionFileChanges } from '../stores/file-changes'
import { useSessionsStore } from '../stores/sessions'
import { FileTypeIcon } from './files/FileTypeIcon'
import { Button } from './ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card'
import { INLINE_CHIP_CLASS } from './inline-chip'
import { FileChangeCounts } from './turn/TurnFileChanges'

/**
 * The worktree a chip's path is relative to, and the session whose recorded edits the hover card
 * counts. Tiptap renders node views through portals inside EditorContent, so the composer provides it
 * around the editor the same way a message bubble does.
 */
export const FileMentionContext = createContext<{ cwd: string | null; sessionId: string | null }>({ cwd: null, sessionId: null })

type InfoState =
  | { status: 'loading' }
  | { status: 'ready'; info: FileMentionInfo }
  | { status: 'error'; message: string }

/** Splits the absolute path so the directory can truncate while the name stays whole. */
function splitPath(path: string): { directory: string; name: string } {
  const name = baseName(path)
  return { directory: path.slice(0, path.length - name.length), name }
}

/**
 * A file referenced with `@`: the name to scan, a hover card with where it lives and how big it is,
 * and, in a sent message, a click that opens it in a file tab. In the composer a click only places
 * the caret. Facts are read on every hover rather than cached, since the agent may have just changed
 * the file.
 */
export function FileMentionChip({ path, opensFile = false, className }: { path: string; opensFile?: boolean; className?: string }) {
  const t = useT()
  const { cwd, sessionId } = useContext(FileMentionContext)
  const edits = useSessionFileChanges(sessionId)?.summary?.files.find((file) => file.relativePath === path)
  const [state, setState] = useState<InfoState>({ status: 'loading' })
  const [copied, setCopied] = useState(false)
  const request = useRef(0)
  const missing = state.status === 'ready' && state.info.kind === 'missing'

  const load = (open: boolean) => {
    setCopied(false)
    // Closing or reopening supersedes the read in flight, so a slow answer cannot overwrite a newer one.
    const id = ++request.current
    if (!open || !cwd) return
    setState({ status: 'loading' })
    api.fileMentionInfo(cwd, path).then(
      (info) => { if (request.current === id) setState({ status: 'ready', info }) },
      (error: unknown) => { if (request.current === id) setState({ status: 'error', message: failureMessage(error) }) }
    )
  }

  const absolutePath = state.status === 'ready' && state.info.kind !== 'missing' ? state.info.absolutePath : path
  const { directory, name } = splitPath(absolutePath)

  const copy = async () => {
    await navigator.clipboard.writeText(absolutePath)
    setCopied(true)
  }

  return (
    <HoverCard openDelay={300} closeDelay={100} onOpenChange={load}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className={cn(INLINE_CHIP_CLASS, missing && 'text-muted-foreground line-through', className)}
          aria-label={path}
          onClick={opensFile ? () => {
            if (cwd && !missing) void useSessionsStore.getState().openFileTab(cwd, path)
          } : undefined}
        >
          <FileTypeIcon path={path} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{baseName(path)}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" collisionPadding={12} className="flex w-auto max-w-[min(28rem,calc(100vw-2rem))] min-w-56 flex-col gap-1.5 rounded-xl p-3">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <FileTypeIcon path={path} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
          <span className="shrink-0 font-medium">{name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto shrink-0"
            aria-label={copied ? t('common.copied') : t('fileMention.copyPath')}
            title={copied ? t('common.copied') : t('fileMention.copyPath')}
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <FileMentionFacts state={state} hasCwd={Boolean(cwd)} />
        {edits ? (
          <p className="flex gap-1.5 text-xs text-muted-foreground">
            <span>{t('fileMention.edited')}</span>
            <FileChangeCounts file={edits} />
          </p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  )
}

function FileMentionFacts({ state, hasCwd }: { state: InfoState; hasCwd: boolean }) {
  const t = useT()
  if (!hasCwd) return null
  if (state.status === 'loading') return <p className="text-xs text-muted-foreground">{t('fileMention.loading')}</p>
  if (state.status === 'error') return <p role="alert" className="text-xs text-destructive">{state.message}</p>
  const { info } = state
  if (info.kind === 'missing') return <p className="text-xs text-muted-foreground">{t('fileMention.missing')}</p>
  const modified = t('fileMention.modified', { time: relativeTime(new Date(info.modifiedAt).toISOString(), t) })
  return (
    <p className="flex gap-3 text-xs text-muted-foreground">
      {info.kind === 'file' && info.lineCount !== null ? <span>{t('fileMention.lines', { n: info.lineCount })}</span> : null}
      <span>{modified}</span>
    </p>
  )
}
