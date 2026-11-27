import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { Check, Copy, Folder } from 'lucide-react'
import { toast } from 'sonner'
import {
  matchOpenedWorkspaceFile,
  parseInlineCodeFileLink,
  parseMarkdownFileLink,
  resolveChatMarkdownImageSrc,
  type ParsedFileTarget
} from '../../../shared/file-links'
import { baseName } from '../../../shared/paths'
import { api, type FileMentionInfo } from '../ipc/api'
import { useT } from '../hooks/useT'
import { relativeTime } from '../lib/relative-time'
import { failureMessage } from '../lib/ipc-error'
import { cn } from '../lib/utils'
import { useSessionFileChanges } from '../stores/file-changes'
import { useFilesStore } from '../stores/files'
import { useSessionsStore } from '../stores/sessions'
import { FileTypeIcon } from './files/FileTypeIcon'
import { ImagePreview } from './ImagePreview'
import {
  INLINE_CODE_CLASS,
  MarkdownImageContext,
  MarkdownInlineCodeContext,
  MarkdownLinkContext
} from './MarkdownText'
import { Button } from './ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card'
import { INLINE_CHIP_CLASS } from './inline-chip'
import { FileChangeCounts } from './turn/TurnFileChanges'

export interface FileMentionContextValue {
  cwd: string | null
  sessionId: string | null
  preferredCwds?: readonly string[]
  onOpenWorkspaceFile?: (cwd: string, relativePath: string, line?: number | null) => void
}

/**
 * The worktree a chip or reply link resolves relative paths against, and the session whose recorded
 * edits the hover card counts. Tiptap renders node views through portals inside EditorContent, so the
 * composer provides it around the editor the same way a turn or Bot reply does.
 */
export const FileMentionContext = createContext<FileMentionContextValue>({ cwd: null, sessionId: null })

/** Suppresses nested inline-code file hover cards when `` [`window.ts`](src/main/window.ts) `` is already wrapped by `<a>`. */
const InsideMarkdownLinkContext = createContext(false)

/** Provides `@file` chip scope plus Markdown link and inline-code file reference rendering for a conversation surface. */
export function FileMentionProvider({
  value,
  children
}: {
  value: FileMentionContextValue
  children?: ReactNode
}) {
  return (
    <FileMentionContext.Provider value={value}>
      <MarkdownLinkContext.Provider value={MarkdownFileLink}>
        <MarkdownImageContext.Provider value={MarkdownChatImage}>
          <MarkdownInlineCodeContext.Provider value={MarkdownInlineCode}>
            {children}
          </MarkdownInlineCodeContext.Provider>
        </MarkdownImageContext.Provider>
      </MarkdownLinkContext.Provider>
    </FileMentionContext.Provider>
  )
}

type InfoState =
  | { status: 'loading' }
  | { status: 'ready'; info: FileMentionInfo }
  | { status: 'error'; message: string }

/** Splits the absolute path so the directory can truncate while the name stays whole. */
function splitPath(path: string): { directory: string; name: string } {
  const name = baseName(path)
  return { directory: path.slice(0, path.length - name.length), name }
}

function FileHoverCard({
  displayPath,
  line,
  editsCwd,
  editsRelativePath,
  canLoad,
  loadInfo,
  children
}: {
  displayPath: string
  line?: number | null
  editsCwd: string | null
  editsRelativePath: string | null
  canLoad: boolean
  loadInfo: () => Promise<FileMentionInfo>
  children: (controls: {
    missing: boolean
    readyInfo: FileMentionInfo | null
    dismiss: () => void
  }) => ReactNode
}) {
  const t = useT()
  const { cwd, sessionId } = useContext(FileMentionContext)
  const sessionFiles = useSessionFileChanges(sessionId)?.summary?.files
  const edits =
    editsRelativePath && (!cwd || editsCwd === cwd)
      ? sessionFiles?.find((file) => file.relativePath === editsRelativePath)
      : undefined
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<InfoState>({ status: 'loading' })
  const [copied, setCopied] = useState(false)
  const request = useRef(0)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    setCopied(false)
    // Closing or reopening supersedes the read in flight, so a slow answer cannot overwrite a newer one.
    const id = ++request.current
    if (!next || !canLoad) return
    setState({ status: 'loading' })
    loadInfo().then(
      (info) => {
        if (request.current === id) setState({ status: 'ready', info })
      },
      (error: unknown) => {
        if (request.current === id) setState({ status: 'error', message: failureMessage(error) })
      }
    )
  }

  const dismiss = () => {
    request.current++
    setOpen(false)
  }

  const readyInfo = state.status === 'ready' ? state.info : null
  const missing = readyInfo?.kind === 'missing'
  const absolutePath = readyInfo && readyInfo.kind !== 'missing' ? readyInfo.absolutePath : displayPath
  const { directory, name } = splitPath(absolutePath)

  const copy = async () => {
    await navigator.clipboard.writeText(absolutePath)
    setCopied(true)
  }

  return (
    <HoverCard open={open} openDelay={300} closeDelay={100} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>{children({ missing, readyInfo, dismiss })}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        collisionPadding={12}
        className="flex w-auto max-w-[min(28rem,calc(100vw-2rem))] min-w-56 flex-col gap-1.5 rounded-xl p-3"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {readyInfo?.kind === 'directory' ? (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileTypeIcon path={absolutePath} className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
          <span className="shrink-0 font-medium">{name}</span>
          {line ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">:{line}</span> : null}
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
        <FileMentionFacts state={state} hasCwd={canLoad} />
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

/**
 * A file referenced with `@`: the name to scan, a hover card with where it lives and how big it is,
 * and, in a sent message, a click that opens it in a file tab. In the composer a click only places
 * the caret. Facts are read on every hover rather than cached, since the agent may have just changed
 * the file.
 */
export function FileMentionChip({ path, opensFile = false, className }: { path: string; opensFile?: boolean; className?: string }) {
  const { cwd } = useContext(FileMentionContext)

  return (
    <FileHoverCard
      displayPath={path}
      editsCwd={cwd}
      editsRelativePath={path}
      canLoad={Boolean(cwd)}
      loadInfo={() => api.fileMentionInfo(cwd!, path)}
    >
      {({ missing, dismiss }) => (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className={cn(INLINE_CHIP_CLASS, missing && 'text-muted-foreground line-through', className)}
          aria-label={path}
          onClick={
            opensFile
              ? () => {
                  if (!cwd || missing) return
                  dismiss()
                  void useSessionsStore.getState().openFileTab(cwd, path, { preview: true })
                }
              : undefined
          }
        >
          <FileTypeIcon path={path} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{baseName(path)}</span>
        </Button>
      )}
    </FileHoverCard>
  )
}

function InteractiveFileReference({
  target,
  resetKey,
  children
}: {
  target: ParsedFileTarget
  resetKey: string | undefined
  children: (handlers: {
    onClick: (event: MouseEvent<HTMLAnchorElement>) => void
    onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => void
  }) => ReactNode
}) {
  const t = useT()
  const { cwd, preferredCwds, onOpenWorkspaceFile } = useContext(FileMentionContext)
  const projects = useSessionsStore((state) => state.projects)
  const [resolvedAbsPath, setResolvedAbsPath] = useState<string | null>(null)

  useEffect(() => {
    setResolvedAbsPath(null)
  }, [resetKey])

  const baseCwd = cwd ?? preferredCwds?.[0] ?? null
  const isOpenWorkspace = (candidate: string): boolean =>
    (Boolean(cwd) && candidate === cwd) ||
    projects.some(
      (proj) => proj.cwd === candidate || proj.worktrees?.some((wt) => !wt.missing && wt.cwd === candidate)
    )

  const directWorkspace = target.relativeToCwd
    ? baseCwd && isOpenWorkspace(baseCwd)
      ? { cwd: baseCwd, relativePath: target.path }
      : null
    : matchOpenedWorkspaceFile(target.path, cwd ? [cwd] : [], projects)

  const externalTargetPath = target.relativeToCwd && baseCwd
    ? `${baseCwd.replace(/[\\/]+$/, '')}/${target.path}`
    : target.path

  const effectiveWorkspace =
    directWorkspace ??
    (resolvedAbsPath ? matchOpenedWorkspaceFile(resolvedAbsPath, cwd ? [cwd] : [], projects) : null)

  const loadInfo = async (): Promise<FileMentionInfo> => {
    if (directWorkspace) {
      return api.fileMentionInfo(directWorkspace.cwd, directWorkspace.relativePath)
    }
    const info = await api.localFileMentionInfo(externalTargetPath)
    if (info.kind !== 'missing') setResolvedAbsPath(info.absolutePath)
    return info
  }

  const openInWorkspace = async (targetCwd: string, relativePath: string): Promise<void> => {
    if (onOpenWorkspaceFile) {
      onOpenWorkspaceFile(targetCwd, relativePath, target.line)
      return
    }
    await useSessionsStore.getState().openFileTab(targetCwd, relativePath, { preview: true })
    if (target.line) useFilesStore.getState().revealLine(targetCwd, relativePath, target.line)
  }

  return (
    <FileHoverCard
      displayPath={externalTargetPath}
      line={target.line}
      editsCwd={effectiveWorkspace?.cwd ?? null}
      editsRelativePath={effectiveWorkspace?.relativePath ?? null}
      canLoad={true}
      loadInfo={loadInfo}
    >
      {({ readyInfo, dismiss }) =>
        children({
          onAuxClick: (event) => event.preventDefault(),
          onClick: (event) => {
            event.preventDefault()
            dismiss()
            void (async () => {
              try {
                if (directWorkspace) {
                  const info =
                    readyInfo ?? (await api.fileMentionInfo(directWorkspace.cwd, directWorkspace.relativePath))
                  if (info.kind === 'missing') {
                    toast.error(t('fileMention.missing'))
                    return
                  }
                  if (info.kind === 'directory') {
                    await api.openFileExternally(directWorkspace.cwd, directWorkspace.relativePath)
                    return
                  }
                  await openInWorkspace(directWorkspace.cwd, directWorkspace.relativePath)
                  return
                }

                const info = readyInfo ?? (await api.localFileMentionInfo(externalTargetPath))
                if (info.kind === 'missing') {
                  toast.error(t('fileMention.missing'))
                  return
                }
                const matched = matchOpenedWorkspaceFile(
                  info.absolutePath,
                  cwd ? [cwd] : [],
                  useSessionsStore.getState().projects
                )
                if (matched && info.kind === 'file') {
                  await openInWorkspace(matched.cwd, matched.relativePath)
                  return
                }
                await api.openLocalFileExternally(info.absolutePath)
              } catch (error) {
                toast.error(failureMessage(error))
              }
            })()
          }
        })
      }
    </FileHoverCard>
  )
}

/**
 * Markdown `<a>` renderer for assistant replies: external URLs open in the browser, while local file
 * paths (`正文/002.md`, `/Users/...`, `file:///...`, `~/...`) show the file hover card and open in a
 * Pig file tab when inside an open workspace (or via the OS default app otherwise).
 */
export const MarkdownFileLink: NonNullable<Components['a']> = function MarkdownFileLink({ id, href, children }) {
  const { cwd, preferredCwds } = useContext(FileMentionContext)
  const baseCwd = cwd ?? preferredCwds?.[0] ?? null
  const parsed = parseMarkdownFileLink(href, baseCwd)
  const wrappedChildren = <InsideMarkdownLinkContext.Provider value={true}>{children}</InsideMarkdownLinkContext.Provider>

  if (parsed.kind === 'external') {
    return (
      <a id={id} href={parsed.href} className="text-link underline underline-offset-2" target="_blank" rel="noreferrer">
        {wrappedChildren}
      </a>
    )
  }

  if (parsed.kind === 'anchor') {
    return (
      <a id={id} href={parsed.href} className="text-link underline underline-offset-2">
        {wrappedChildren}
      </a>
    )
  }

  if (parsed.kind === 'blocked') {
    return (
      <a
        id={id}
        href={href || undefined}
        className="text-link underline underline-offset-2"
        onClick={(event) => event.preventDefault()}
      >
        {wrappedChildren}
      </a>
    )
  }

  return (
    <InteractiveFileReference target={parsed} resetKey={href}>
      {({ onClick, onAuxClick }) => (
        <a
          id={id}
          href={href}
          draggable={false}
          data-file-link={parsed.path}
          className="cursor-pointer text-link underline underline-offset-2"
          onAuxClick={onAuxClick}
          onClick={onClick}
        >
          {wrappedChildren}
        </a>
      )}
    </InteractiveFileReference>
  )
}

/**
 * Markdown `<img>` renderer for chat and Bot replies: rewrites local workspace and disk image paths
 * (`地图/王城.png`, `/Users/...`, `file:///...`, `~/...`) to `pig-file:` URLs and opens `ImagePreview`
 * on click when standalone.
 */
export const MarkdownChatImage: NonNullable<Components['img']> = function MarkdownChatImage({
  src,
  alt,
  title,
  width,
  height
}) {
  const t = useT()
  const insideLink = useContext(InsideMarkdownLinkContext)
  const { cwd, preferredCwds } = useContext(FileMentionContext)
  const projects = useSessionsStore((state) => state.projects)
  const [preview, setPreview] = useState<string | null>(null)

  const resolvedSrc =
    typeof src === 'string'
      ? resolveChatMarkdownImageSrc(src, { cwd, preferredCwds, projects })
      : undefined

  if (!resolvedSrc || insideLink) {
    return (
      <img
        src={resolvedSrc}
        alt={alt ?? ''}
        title={title}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        className="my-1.5 block max-h-96 max-w-full rounded-lg object-contain sm:max-w-lg"
      />
    )
  }

  return (
    <>
      <img
        src={resolvedSrc}
        alt={alt ?? ''}
        title={title}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        role="button"
        tabIndex={0}
        aria-label={alt || t('composer.previewImage')}
        onClick={() => setPreview(resolvedSrc)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setPreview(resolvedSrc)
          }
        }}
        className="my-1.5 block max-h-96 max-w-full cursor-zoom-in rounded-lg object-contain focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring focus-visible:outline-none sm:max-w-lg"
      />
      {preview ? <ImagePreview src={preview} onClose={() => setPreview(null)} /> : null}
    </>
  )
}

/**
 * Inline backtick `<code>` renderer for assistant replies: turns recognized file paths (such as
 * `` `/Users/.../红线啦啦啦.md` `` or `` `src/main/window.ts:67` ``) into clickable file references with
 * the same hover card, while leaving commands, API routes, and code snippets as plain `<code>`.
 */
export function MarkdownInlineCode({ text, children }: { text: string; children: ReactNode }): ReactNode {
  const insideLink = useContext(InsideMarkdownLinkContext)
  const { cwd, preferredCwds } = useContext(FileMentionContext)
  const projects = useSessionsStore((state) => state.projects)

  if (insideLink) {
    return <code className={INLINE_CODE_CLASS}>{children}</code>
  }

  const baseCwd = cwd ?? preferredCwds?.[0] ?? null
  const target = parseInlineCodeFileLink(text, baseCwd, projects)
  if (!target) {
    return <code className={INLINE_CODE_CLASS}>{children}</code>
  }

  return (
    <InteractiveFileReference target={target} resetKey={text}>
      {({ onClick, onAuxClick }) => (
        <a
          href={`#${encodeURIComponent(target.path)}`}
          draggable={false}
          data-file-code={target.path}
          className="cursor-pointer rounded-sm no-underline focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring focus-visible:outline-none"
          onAuxClick={onAuxClick}
          onClick={onClick}
        >
          <code
            className={cn(
              INLINE_CODE_CLASS,
              'text-link underline decoration-link/40 underline-offset-2 transition-colors hover:bg-foreground/14 hover:decoration-link solid:hover:bg-foreground/12'
            )}
          >
            {children}
          </code>
        </a>
      )}
    </InteractiveFileReference>
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
