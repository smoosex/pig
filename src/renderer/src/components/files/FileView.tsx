/**
 * One file in the conversation area: a header that names it and hands it to the desktop, the library's
 * own editor filling the rest.
 *
 * The editor owns the document for as long as its surface is mounted, so the store takes the draft from
 * `onEditChange` rather than feeding it back — and a reload becomes a new surface, keyed by the document
 * and its revision, instead of an update handed to a session that is already in progress. ⌘S is caught on
 * the way down: the editor has a keymap of its own, and saving is the tab's business rather than the
 * editor's.
 */
import { useEffect, useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import {
  Editor,
  type EditorChangeEvent,
  type EditorFactory,
  type FileEditCompleteEvent
} from '@pierre/diffs/edit'
import { EditProvider, File as FileCode, Virtualizer } from '@pierre/diffs/react'
import { api } from '../../ipc/api'
import { fileIcon, splitPath } from '../diff/file-entry'
import { fileCodeOptions } from '../diff/diff-options'
import { isDirty, fileKey, watchWorktreeFiles, useFilesStore, type FileDocument } from '../../stores/files'
import { failureMessage } from '../../lib/ipc-error'
import { useDarkMode } from '../../lib/useDarkMode'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

const createEditor: EditorFactory<undefined, undefined> = (type, options, editStateKey) =>
  new Editor(type, options, editStateKey)

export default function FileView({ cwd, path }: { cwd: string; path: string }) {
  const document = useFilesStore((state) => state.documents[fileKey(cwd, path)])
  const openDocument = useFilesStore((state) => state.openDocument)
  const setDraft = useFilesStore((state) => state.setDraft)
  const saveDocument = useFilesStore((state) => state.saveDocument)
  const reloadDocument = useFilesStore((state) => state.reloadDocument)
  const dark = useDarkMode()
  // The menu's answer arrives after it closes, so it is the pane that has to say anything about it. The
  // header is not remounted when the tab switches to another file, so the message is dropped on the way.
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    watchWorktreeFiles()
    void openDocument(cwd, path)
  }, [cwd, path, openDocument])

  useEffect(() => setActionError(null), [cwd, path])

  const runExternal = (run: () => Promise<unknown>) => {
    setActionError(null)
    void run().catch((error: unknown) => setActionError(failureMessage(error)))
  }

  const Icon = document?.preview === 'text' ? fileIcon(path) : FileText
  const { name, directory } = splitPath(path)
  const dirty = document ? isDirty(document) : false
  const saving = document?.saving === true

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
        event.preventDefault()
        if (dirty && !saving) void saveDocument(cwd, path)
      }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium" title={path}>
          {name}
        </span>
        {directory ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{directory}</span>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={!dirty || saving}
          onClick={() => void saveDocument(cwd, path)}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="text-muted-foreground">
              打开方式…
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => runExternal(() => api.openFileExternally(cwd, path))}>
              用默认应用打开
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => runExternal(() => api.revealFileExternally(cwd, path))}>
              在文件管理器中显示
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {document?.stale ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-background px-3 py-1.5 text-xs text-warning">
          <span className="min-w-0 flex-1 truncate">文件已在磁盘上变化</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-warning"
            onClick={() => void reloadDocument(cwd, path)}
          >
            重新加载
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-warning"
            disabled={saving}
            onClick={() => void saveDocument(cwd, path, true)}
          >
            覆盖
          </Button>
        </div>
      ) : document?.refreshError ? (
        // No 覆盖 here: nothing is known about the bytes on disk, so the only honest offer is a retry.
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-background px-3 py-1.5 text-xs text-warning">
          <span className="min-w-0 flex-1 truncate">读取失败：{document.refreshError}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-warning"
            onClick={() => void reloadDocument(cwd, path)}
          >
            重新加载
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-destructive" role="alert">
          打开失败：{actionError}
        </p>
      ) : null}

      {document?.saveError ? (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-destructive" role="alert">
          保存失败：{document.saveError}
        </p>
      ) : null}

      {document?.status === 'ready' && document.preview === 'text' ? (
        <FileSurface
          key={`${fileKey(cwd, path)}-${document.revision}`}
          path={path}
          contents={document.text}
          dark={dark}
          onEditChange={(text) => setDraft(cwd, path, text)}
        />
      ) : (
        // A read that failed is the one preview with a way out of it: nothing about the file itself says
        // it is unreadable, so the tab offers the read again rather than making the reader close it.
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{notice(document)}</span>
          {document?.status === 'error' ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0"
              onClick={() => void reloadDocument(cwd, path)}
            >
              重新加载
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
  onEditChange
}: {
  path: string
  contents: string
  dark: boolean
  onEditChange: (text: string) => void
}) {
  const [file] = useState(() => ({ name: path, contents }))
  const options = useMemo(() => fileCodeOptions(dark), [dark])
  return (
    <EditProvider createEditor={createEditor}>
      <Virtualizer className="min-h-0 flex-1 overflow-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <FileCode
          file={file}
          options={options}
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

function notice(document: FileDocument | undefined): string {
  if (!document || document.status === 'loading') return '正在读取文件…'
  if (document.status === 'error') return document.error ?? '无法读取这个文件'
  switch (document.preview) {
    case 'binary':
      return '这是二进制文件，不在这里打开'
    case 'too-large':
      return '文件超过 2 MB，不在这里打开'
    case 'link':
      return '这是符号链接，不跟随：打开它就会读到工作区之外的文件'
    default:
      return '文件不存在'
  }
}
