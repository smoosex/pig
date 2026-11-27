/**
 * One file in the conversation area: a header that names it and hands it to the desktop, the library's
 * own editor filling the rest.
 *
 * The editor owns the document for as long as its surface is mounted, so the store takes the draft from
 * `onEditChange` rather than feeding it back — and a reload becomes a new surface, keyed by the document
 * and its revision, instead of an update handed to a session that is already in progress. ⌘S is caught on
 * the way down: the editor has a keymap of its own, and saving is the tab's business rather than the
 * editor's. A diff row followed into the tab lands the editor on that line, which is what
 * `useFileLineReveal` holds.
 *
 * Markdown opens on a rendered preview of the draft. The editor stays mounted behind it, so switching
 * views keeps unsaved edits and undo history, and a line reveal switches to the source it needs. The
 * preview resolves relative links and images against the file's own directory, the way a repository
 * browser reads a README, and renders the sanitized HTML READMEs use for layout.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import type { Translate } from '../../../../shared/i18n'
import {
  Editor,
  type EditorChangeEvent,
  type EditorFactory,
  type FileEditCompleteEvent
} from '@pierre/diffs/edit'
import { EditProvider, File as FileCode, Virtualizer } from '@pierre/diffs/react'
import { api } from '../../ipc/api'
import { splitPath } from '../diff/file-entry'
import { FileTypeIcon } from './FileTypeIcon'
import { fileCodeOptions } from '../diff/diff-options'
import {
  fileKey,
  isDirty,
  rememberFileScroll,
  rememberMarkdownPreviewScroll,
  savedFileScroll,
  useFilesStore,
  watchWorktreeFiles,
  type FileDocument
} from '../../stores/files'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { useDarkMode } from '../../lib/useDarkMode'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { useFileLineReveal } from './useFileLineReveal'
import { Code, Eye } from 'lucide-react'
import { MarkdownText } from '../MarkdownText'
import { cn } from '../../lib/utils'
import { isComposingKey, isShortcutRecording, matchesShortcut } from '../../lib/shortcuts'
import { useSessionsStore } from '../../stores/sessions'
import { fileTabId } from '../../stores/sessions/tabs-slice'
import { headingSlug, markdownImageSrc, markdownTarget } from './markdown-links'

const MARKDOWN_PATH = /\.(md|markdown)$/i

const createEditor: EditorFactory<undefined, undefined> = (type, options, editStateKey) =>
  new Editor(type, options, editStateKey)

export default function FileView({ cwd, path }: { cwd: string; path: string }) {
  const document = useFilesStore((state) => state.documents[fileKey(cwd, path)])
  const openDocument = useFilesStore((state) => state.openDocument)
  const setDraft = useFilesStore((state) => state.setDraft)
  const saveDocument = useFilesStore((state) => state.saveDocument)
  const reloadDocument = useFilesStore((state) => state.reloadDocument)
  const t = useT()
  const dark = useDarkMode()
  // The menu's answer arrives after it closes, so it is the pane that has to say anything about it. The
  // header is not remounted when the tab switches to another file, so the message is dropped on the way.
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    watchWorktreeFiles()
    void openDocument(cwd, path)
  }, [cwd, path, openDocument])

  useEffect(() => setActionError(null), [cwd, path])

  // View mode and scroll offsets live in the files store so switching tabs (or refreshing on disk)
  // preserves the reader's exact place until the file tab itself is closed.
  const key = fileKey(cwd, path)
  const sourceChosen = useFilesStore((state) => Boolean(state.sourceViews[key]))
  const setShowSource = useFilesStore((state) => state.setShowSource)
  const showSource = (source: boolean) => setShowSource(cwd, path, source)
  const revealPending = useFilesStore((state) => state.reveal?.cwd === cwd && state.reveal?.path === path)
  useEffect(() => {
    if (revealPending) setShowSource(cwd, path, true)
  }, [revealPending, cwd, path, setShowSource])

  // The line a diff row asked for, and the editor that can be told about it.
  const reveal = useFileLineReveal(cwd, path, document)

  const runExternal = (run: () => Promise<unknown>) => {
    setActionError(null)
    void run().catch((error: unknown) => setActionError(failureMessage(error)))
  }

  const previewRef = useRef<HTMLDivElement>(null)
  const openFileTab = useSessionsStore((state) => state.openFileTab)
  const previewComponents = useMemo<Components>(() => {
    // Footnotes and HTML anchors carry ids, which the sanitizer prefixes with `user-content-`;
    // headings have none, so they are matched by GitHub's slug of their text.
    const scrollToAnchor = (slug: string) => {
      const preview = previewRef.current
      if (!preview) return
      const ids = new Set([slug, `user-content-${slug}`])
      const target = [...preview.querySelectorAll<HTMLElement>('[id]')].find((element) => ids.has(element.id)) ??
        [...preview.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
          .find((heading) => headingSlug(heading.textContent ?? '') === slug.toLowerCase())
      target?.scrollIntoView({ block: 'start' })
    }
    return {
      a: ({ id, href = '', children }) => {
        const target = markdownTarget(path, href)
        return (
          <a
            id={id}
            href={href}
            className="text-link underline underline-offset-2"
            {...(target.kind === 'external' ? { target: '_blank', rel: 'noreferrer' } : {})}
            onClick={(event) => {
              if (target.kind === 'external') return
              // Everything else stays inside the app: the window would resolve it against its own URL.
              event.preventDefault()
              if (target.kind === 'anchor') scrollToAnchor(target.slug)
              else if (target.kind === 'file' && target.path === path) {
                if (target.slug) scrollToAnchor(target.slug)
              } else if (target.kind === 'file') {
                runExternal(() => openFileTab(cwd, target.path, { preview: true }))
              }
            }}
          >
            {children}
          </a>
        )
      },
      img: ({ src, alt, title, width, height }) => (
        <img
          src={typeof src === 'string' ? markdownImageSrc(cwd, path, src) : undefined}
          alt={alt}
          title={title}
          width={width}
          height={height}
          className="inline max-w-full"
        />
      )
    }
  }, [cwd, path, openFileTab])

  const { name, directory } = splitPath(path)
  const dirty = document ? isDirty(document) : false
  const saving = document?.saving === true
  const markdown = MARKDOWN_PATH.test(path) && document?.status === 'ready' && document.preview === 'text'
  // A pending reveal shows the source in the same commit, so the editor is visible when it is focused.
  const previewing = markdown && !sourceChosen && !revealPending
  const [editorWarmKey, setEditorWarmKey] = useState<string | null>(null)
  const mountEditor = !previewing || dirty || editorWarmKey === key

  useEffect(() => {
    if (document?.status !== 'ready' || document.preview !== 'text') return
    if (editorWarmKey === key) return
    if (!previewing || dirty) {
      setEditorWarmKey(key)
      return
    }
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(() => setEditorWarmKey(key), { timeout: 300 })
      return () => window.cancelIdleCallback(idle)
    }
    const timer = window.setTimeout(() => setEditorWarmKey(key), 0)
    return () => window.clearTimeout(timer)
  }, [dirty, document?.preview, document?.status, editorWarmKey, key, previewing])

  // Restore and track Markdown preview scroll position across tab switches, preview toggles, and disk updates.
  useLayoutEffect(() => {
    if (!previewing) return
    const preview = previewRef.current
    if (!preview) return
    const targetTop = savedFileScroll(key).previewScrollTop
    let frame = 0
    let tries = 0
    let cancelled = false
    const stop = () => {
      cancelled = true
      if (frame) cancelAnimationFrame(frame)
    }
    if (targetTop > 0) {
      const restore = () => {
        if (cancelled || !preview.isConnected) return
        preview.scrollTop = targetTop
        if (preview.scrollTop < targetTop && tries++ < 30) {
          frame = requestAnimationFrame(restore)
        }
      }
      restore()
    }
    const onScroll = () => {
      if (!preview.isConnected) return
      // Avoid overwriting a saved offset before async layout has given the container scrollable height.
      if (preview.scrollTop === 0 && targetTop > 0 && !cancelled && preview.scrollHeight <= preview.clientHeight) {
        return
      }
      rememberMarkdownPreviewScroll(key, preview.scrollTop)
    }
    preview.addEventListener('scroll', onScroll, { passive: true })
    preview.addEventListener('wheel', stop, { passive: true })
    preview.addEventListener('pointerdown', stop)
    preview.addEventListener('touchstart', stop, { passive: true })
    return () => {
      stop()
      preview.removeEventListener('scroll', onScroll)
      preview.removeEventListener('wheel', stop)
      preview.removeEventListener('pointerdown', stop)
      preview.removeEventListener('touchstart', stop)
    }
  }, [previewing, key, document?.revision])

  return (
    <div
      className="glass-code-surface flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        if (isShortcutRecording() || isComposingKey(event.nativeEvent) || !matchesShortcut(event.nativeEvent, 'file.save')) return
        event.preventDefault()
        if (dirty && !saving) void saveDocument(cwd, path)
      }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-glass-border px-3 solid:border-border">
        <FileTypeIcon path={path} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium" title={path}>
          {name}
        </span>
        {directory ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{directory}</span>
        ) : null}
        <span className="flex-1" />
        {markdown ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            data-markdown-view-toggle
            aria-label={previewing ? t('file.showSource') : t('file.showPreview')}
            title={previewing ? t('file.showSource') : t('file.showPreview')}
            onClick={() => showSource(previewing)}
          >
            {previewing ? <Code /> : <Eye />}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={!dirty || saving}
          onClick={() => void saveDocument(cwd, path)}
        >
          {saving ? t('file.saving') : t('file.save')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="text-muted-foreground">
              {t('file.openWith')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => runExternal(() => api.openFileExternally(cwd, path))}>
              {t('file.openDefault')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => runExternal(() => api.revealFileExternally(cwd, path))}>
              {t('file.reveal')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {document?.stale ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-background px-3 py-1.5 text-xs text-warning">
          <span className="min-w-0 flex-1 truncate">{t('file.changedOnDisk')}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-warning"
            onClick={() => void reloadDocument(cwd, path)}
          >
            {t('file.reload')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-warning"
            disabled={saving}
            onClick={() => void saveDocument(cwd, path, true)}
          >
            {t('file.overwrite')}
          </Button>
        </div>
      ) : document?.refreshError ? (
        // No overwrite here: nothing is known about the bytes on disk, so the only honest offer is a retry.
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-background px-3 py-1.5 text-xs text-warning">
          <span className="min-w-0 flex-1 truncate">
            {t('file.readFailed', { error: document.refreshError })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-warning"
            onClick={() => void reloadDocument(cwd, path)}
          >
            {t('file.reload')}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-destructive" role="alert">
          {t('file.openFailed', { error: actionError })}
        </p>
      ) : null}

      {document?.saveError ? (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-destructive" role="alert">
          {t('file.saveFailed', { error: document.saveError })}
        </p>
      ) : null}

      {document?.status === 'ready' && document.preview === 'text' ? (
        // The editor keeps its layout under the preview: hiding it with display would make the virtualizer
        // measure and paint from scratch when the source comes back, which shows as a flash.
        <div className="relative flex min-h-0 flex-1 flex-col">
          {previewing ? (
            <div ref={previewRef} data-markdown-preview className="absolute inset-0 overflow-y-auto px-6 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <MarkdownText className="mx-auto max-w-3xl text-sm" text={document.text} allowHtml overrides={previewComponents} />
            </div>
          ) : null}
          {mountEditor ? (
            <FileSurface
              key={key}
              surfaceKey={key}
              path={path}
              contents={document.text}
              revision={document.revision}
              dark={dark}
              hidden={previewing}
              revealPending={Boolean(revealPending)}
              editorOptions={reveal.editorOptions}
              onDetach={reveal.onDetach}
              onEditChange={(text) => {
                if (useFilesStore.getState().documents[key]?.text === text) return
                setDraft(cwd, path, text)
                useSessionsStore.getState().pinFileTab?.(fileTabId(cwd, path))
              }}
            />
          ) : null}
        </div>
      ) : (
        // A read that failed is the one preview with a way out of it: nothing about the file itself says
        // it is unreadable, so the tab offers the read again rather than making the reader close it.
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{notice(document, t)}</span>
          {document?.status === 'error' ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0"
              onClick={() => void reloadDocument(cwd, path)}
            >
              {t('file.reload')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * Editable code surface keyed by `fileKey(cwd, path)` (without revision) so external disk updates
 * replace `file` in place inside the live `<Virtualizer>` rather than tearing down the scroll viewport.
 * Across tab switches or explicit reloads, `editStateKey` retains same-revision editor state while
 * `savedFileScroll` restores the exact `scrollTop` / `scrollLeft` once virtualized content settles.
 */
function FileSurface({
  surfaceKey,
  path,
  contents,
  revision,
  dark,
  hidden,
  revealPending,
  editorOptions,
  onDetach,
  onEditChange
}: {
  surfaceKey: string
  path: string
  contents: string
  revision: number
  dark: boolean
  hidden: boolean
  revealPending: boolean
  editorOptions: { onAttach: (editor: Editor<'file', undefined, undefined>) => void }
  onDetach: () => void
  onEditChange: (text: string) => void
}) {
  // Recompute `file` only when `revision` changes (disk refresh / reload), never on user keystrokes.
  const file = useMemo(() => ({ name: path, contents }), [path, revision])
  const options = useMemo(() => fileCodeOptions(dark), [dark])
  const hostRef = useRef<HTMLDivElement>(null)
  const revealRef = useRef(revealPending)
  revealRef.current = revealPending

  useEffect(() => () => onDetach(), [onDetach])

  useLayoutEffect(() => {
    const scroller = hostRef.current?.firstElementChild
    if (!(scroller instanceof HTMLElement)) return
    const target = savedFileScroll(surfaceKey)
    let frame = 0
    let tries = 0
    let cancelled = false
    const stop = () => {
      cancelled = true
      if (frame) cancelAnimationFrame(frame)
    }

    if (!revealRef.current && (target.scrollTop > 0 || target.scrollLeft > 0)) {
      const restore = () => {
        if (cancelled || revealRef.current || !scroller.isConnected) return
        if (target.scrollTop > 0) scroller.scrollTop = target.scrollTop
        if (target.scrollLeft > 0) scroller.scrollLeft = target.scrollLeft
        const needsMore =
          (target.scrollTop > 0 && scroller.scrollTop < target.scrollTop) ||
          (target.scrollLeft > 0 && scroller.scrollLeft < target.scrollLeft)
        if (needsMore && tries++ < 60) {
          frame = requestAnimationFrame(restore)
        }
      }
      restore()
    }

    const onScroll = () => {
      if (hidden || !scroller.isConnected) return
      // Ignore transient 0,0 scroll events before the virtualizer has expanded its content height.
      if (
        scroller.scrollTop === 0 &&
        scroller.scrollLeft === 0 &&
        (target.scrollTop > 0 || target.scrollLeft > 0) &&
        !cancelled &&
        scroller.scrollHeight <= scroller.clientHeight
      ) {
        return
      }
      rememberFileScroll(surfaceKey, scroller.scrollTop, scroller.scrollLeft)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', stop, { passive: true })
    scroller.addEventListener('pointerdown', stop)
    scroller.addEventListener('touchstart', stop, { passive: true })
    scroller.addEventListener('keydown', stop)
    return () => {
      stop()
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', stop)
      scroller.removeEventListener('pointerdown', stop)
      scroller.removeEventListener('touchstart', stop)
      scroller.removeEventListener('keydown', stop)
    }
  }, [surfaceKey, revision, hidden])

  return (
    <EditProvider createEditor={createEditor}>
      <div ref={hostRef} className="flex min-h-0 flex-1 flex-col">
        {/* No block gap around the code: the opaque gutter would otherwise stop short of the header and the
            card edge, with the glass backplate showing through above and below it. */}
        <Virtualizer className={cn('min-h-0 flex-1 overflow-auto [--diffs-gap-block:0px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', hidden && 'invisible')}>
          <FileCode
            file={file}
            options={options}
            editorOptions={editorOptions}
            editStateKey={`${surfaceKey}:${revision}`}
            edit
            onEditChange={(event: EditorChangeEvent<'file', undefined, undefined>) =>
              onEditChange(event.file.contents)
            }
            onEditComplete={(_event: FileEditCompleteEvent<undefined, undefined>) => 'accept' as const}
          />
        </Virtualizer>
      </div>
    </EditProvider>
  )
}

function notice(document: FileDocument | undefined, t: Translate): string {
  if (!document || document.status === 'loading') return t('file.loading')
  if (document.status === 'error') return document.error ?? t('file.unreadable')
  switch (document.preview) {
    case 'binary':
      return t('file.ignoredBinary')
    case 'too-large':
      return t('file.ignoredLarge')
    case 'link':
      return t('file.ignoredSymlink')
    default:
      return t('file.missing')
  }
}
