/** Right-click actions for one tab, shared by the tab strip and each split pane's header. */
import type { ReactElement } from 'react'
import { Copy, Download, FolderOutput, PenLine } from 'lucide-react'
import { api } from '../ipc/api'
import { useSessionsStore, type OpenTab } from '../stores/sessions'
import type { useProjectAction } from './sidebar/project-action'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { useT } from '../hooks/useT'

export function TabContextMenu({
  tabId,
  kind,
  action,
  editing,
  onRename,
  children
}: {
  tabId: string
  kind: OpenTab['kind']
  action: ReturnType<typeof useProjectAction>
  editing: boolean
  onRename: () => void
  children: ReactElement
}) {
  const t = useT()
  const { pending, runAction } = action
  if (kind !== 'project' && kind !== 'chat' && kind !== 'terminal') return children
  const copyId = (
    <ContextMenuItem
      disabled={pending !== null}
      onSelect={() => void runAction('copy-id', () => navigator.clipboard.writeText(tabId))}
    >
      <Copy data-icon="inline-start" />
      {kind === 'terminal' ? t('terminal.copyId') : t('sessions.copyId')}
    </ContextMenuItem>
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={editing}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {kind === 'terminal' ? copyId : (
          <>
            <ContextMenuItem onSelect={onRename}>
              <PenLine data-icon="inline-start" />
              {t('common.rename')}
            </ContextMenuItem>
            {kind === 'chat' ? (
              <ContextMenuItem
                disabled={pending !== null}
                onSelect={() => {
                  const state = useSessionsStore.getState()
                  const tab = state.openTabs.find((item) => item.id === tabId)
                  if (tab?.cwd) {
                    state.openConvertChatDialog({
                      sessionId: tab.id,
                      chatCwd: tab.cwd,
                      title: tab.title
                    })
                  }
                }}
              >
                <FolderOutput data-icon="inline-start" />
                {t('sessions.convertToProject')}
              </ContextMenuItem>
            ) : null}
            {copyId}
            <ContextMenuItem
              disabled={pending !== null}
              onSelect={() => void runAction('export', () => api.exportSession(tabId))}
            >
              <Download data-icon="inline-start" />
              {t('sessions.export')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
