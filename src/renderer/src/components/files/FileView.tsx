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
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { isDirty, fileKey, watchWorktreeFiles, useFilesStore, type FileDocument } from '../../stores/files'
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

  // The view choice belongs to one file; the component itself is reused when the tab switches files.
  const key = fileKey(cwd, path)
  const [sourceFor, setSourceFor] = useState<ReadonlySet<string>>(() => new Set())
  const showSource = (file: string, source: boolean) =>
    setSourceFor((current) => {
      if (current.has(file) === source) return current
      const next = new Set(current)
      if (source) next.add(file)
      else next.delete(file)
      return next
    })
  const revealPending = useFilesStore((state) => state.reveal?.cwd === cwd && state.reveal?.path === path)
  useEffect(() => {
    if (revealPending) showSource(key, true)
  }, [revealPending, key])

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
                runExternal(() => openFileTab(cwd, target.path))
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
  const previewing = markdown && !sourceFor.has(key) && !revealPending

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
            onClick={() => showSource(key, previewing)}
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
          <FileSurface
            key={`${fileKey(cwd, path)}-${document.revision}`}
            path={path}
            contents={document.text}
            dark={dark}
            hidden={previewing}
            editorOptions={reveal.editorOptions}
            onEditChange={(text) => setDraft(cwd, path, text)}
          />
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
 * The editable surface for one revision of the file. It reads its starting bytes once, when it mounts:
 * everything the editor does after that belongs to the editor, and the next revision is a different
 * component as far as React is concerned.
 *
 * That key has to name the document, not just the revision: revisions count from zero inside each
 * document, so two files that were each read once both sit at 1, and switching straight between two
 * loaded tabs would hand the new path the editor of the old one. The same goes for two worktrees holding
 * the same relative path, which is why the path alone is not enough either.
 */
function FileSurface({
  path,
  contents,
  dark,
  hidden,
  editorOptions,
  onEditChange
}: {
  path: string
  contents: string
  dark: boolean
  hidden: boolean
  editorOptions: { onAttach: (editor: Editor<'file', undefined, undefined>) => void }
  onEditChange: (text: string) => void
}) {
  const [file] = useState(() => ({ name: path, contents }))
  const options = useMemo(() => fileCodeOptions(dark), [dark])
  return (
    <EditProvider createEditor={createEditor}>
      {/* No block gap around the code: the opaque gutter would otherwise stop short of the header and the
          card edge, with the glass backplate showing through above and below it. */}
      <Virtualizer className={cn('min-h-0 flex-1 overflow-auto [--diffs-gap-block:0px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', hidden && 'invisible')}>
        <FileCode
          file={file}
          options={options}
          editorOptions={editorOptions}
          edit
          onEditChange={(event: EditorChangeEvent<'file', undefined, undefined>) =>
            onEditChange(event.file.contents)
          }
          onEditComplete={(_event: FileEditCompleteEvent<undefined, undefined>) => 'accept' as const}
        />
      </Virtualizer>
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
