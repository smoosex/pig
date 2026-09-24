import { useState } from 'react'
import { CircleAlert, FileDiff, LoaderCircle, PenLine, Plus, SquareText, X } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import type { OpenTab } from '../stores/sessions'
import { fileKey, isDirty, useFilesStore } from '../stores/files'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from './ui/context-menu'
import { SessionRenameField, useSessionRename } from './SessionRenameField'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { CloseSpin } from './RunningSpinners'
import { fileIcon } from './diff/file-entry'
import type { SidebarTab } from '../../../shared/api'
import { stripShowsChats, visibleTabsFor } from './tab-strip'

/** The strip follows the sidebar switcher, not the workspace: the projects half lists the open
 * worktree's tabs, the chats half the chats, and outside a project it falls back to chats. */
export function TabBar({ sidebarTab }: { sidebarTab: SidebarTab }) {
  const t = useT()
  const openTabs = useSessionsStore((state) => state.openTabs)
  const activeTabId = useSessionsStore((state) => state.activeTabId)
  const currentProjectCwd = useSessionsStore((state) => state.currentProjectCwd)
  const workspaceError = useSessionsStore((state) => state.workspaceError)
  const setActive = useSessionsStore((state) => state.setActive)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const newSession = useSessionsStore((state) => state.newSession)
  const newChat = useSessionsStore((state) => state.newChat)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const visibleTabs = visibleTabsFor(openTabs, sidebarTab, currentProjectCwd)

  const createTab = async () => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    try {
      // The button makes whatever the strip is listing, so the projects half only creates a session
      // once there is a worktree for it to belong to.
      if (stripShowsChats(sidebarTab, currentProjectCwd)) await newChat()
      else if (currentProjectCwd) await newSession(currentProjectCwd)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-stretch">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleTabs.map((tab) => (
          <Tab
            key={tab.id}
            tabId={tab.id}
            cwd={tab.cwd}
            title={tab.title}
            kind={tab.kind}
            path={tab.path}
            sessionPath={tab.meta?.path}
            active={tab.id === activeTabId}
            loading={tab.loadState === 'opening'}
            error={tab.loadState === 'error' ? tab.loadError : undefined}
            onSelect={() => setActive(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
      </div>
      <div className="no-drag relative flex shrink-0 items-center gap-0.5 px-1.5 before:absolute before:top-2 before:bottom-2 before:left-0 before:w-px before:bg-border">
        {workspaceError ? (
          <span title={workspaceError} role="alert" className="text-destructive">
            <CircleAlert />
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('tabBar.new')}
          aria-busy={creating}
          title={createError ?? t('tabBar.new')}
          disabled={creating}
          onClick={() => void createTab()}
        >
          {creating ? (
            <LoaderCircle className="animate-spin" />
          ) : createError ? (
            <CircleAlert className="text-destructive" />
          ) : (
            <Plus />
          )}
        </Button>
      </div>
    </div>
  )
}

function Tab({
  tabId,
  cwd,
  title,
  kind,
  path,
  sessionPath,
  active,
  loading,
  error,
  onSelect,
  onClose
}: {
  tabId: string
  cwd: string
  title: string
  kind: OpenTab['kind']
  path?: string
  sessionPath?: string
  active: boolean
  loading: boolean
  error?: string
  onSelect: () => void
  onClose: () => void
}) {
  const streaming = useSessionsStore((state) => state.runtime[tabId]?.isStreaming ?? false)
  const t = useT()
  const dirty = useFilesStore((state) => {
    const document = path ? state.documents[fileKey(cwd, path)] : undefined
    return document ? isDirty(document) : false
  })
  const rename = useSessionRename(tabId, sessionPath)
  // A changes or file tab holds no session, so there is no name to write for it.
  const renamable = kind === 'project' || kind === 'chat'
  const failure = error ?? rename.error ?? undefined
  const FileIcon = path ? fileIcon(path) : SquareText
  const body = (
    <div
      className={cn(
        'group/tab no-drag relative flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs whitespace-nowrap after:absolute after:top-2 after:right-0 after:bottom-2 after:w-px after:bg-border last:after:hidden',
        active
          ? 'bg-card text-foreground before:absolute before:right-2 before:bottom-0 before:left-2 before:h-0.5 before:bg-primary'
          : 'text-muted-foreground'
      )}
      title={failure}
      onClick={onSelect}
    >
      <span className="relative flex size-6 shrink-0 items-center justify-center">
        {kind === 'diff' ? (
          <FileDiff className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/tab:opacity-0" aria-hidden />
        ) : kind === 'file' ? (
          <FileIcon className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/tab:opacity-0" aria-hidden />
        ) : (
          <SquareText className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/tab:opacity-0" aria-hidden />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="no-drag absolute opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 text-muted-foreground hover:text-foreground"
          aria-label={t('sessions.close', { title })}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <span className="relative inline-flex size-3.5 items-center justify-center">
            {streaming ? <CloseSpin /> : null}
            <X className="size-2.5" />
          </span>
        </Button>
      </span>
      {rename.editing ? (
        <SessionRenameField
          className="h-5 w-35"
          value={title}
          onCommit={rename.commit}
          onCancel={rename.cancel}
        />
      ) : (
        <span className="max-w-35 truncate">{title}</span>
      )}
      {dirty ? <span role="img" aria-label={t('tabBar.unsaved')} className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
      {loading ? <LoaderCircle className="animate-spin" aria-label={t('tabBar.loading')} /> : null}
      {failure ? <CircleAlert className="text-destructive" aria-label={failure} /> : null}
    </div>
  )

  if (!renamable) return body
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={rename.editing}>
        {body}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={rename.start}>
          <PenLine data-icon="inline-start" />
          {t('common.rename')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
