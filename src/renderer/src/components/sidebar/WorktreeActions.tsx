import { useState } from 'react'
import { GitBranch, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { api } from '../../ipc/api'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useT } from '../../hooks/useT'
import { sidebarButtonSurface } from './sidebar-surface'
import type { RunProjectAction } from './project-action'

export function CreateWorktreeButton({
  projectCwd,
  hasGit,
  disabled,
  busy,
  runAction,
  onCreate
}: {
  projectCwd: string
  hasGit: boolean
  disabled: boolean
  busy: boolean
  runAction: RunProjectAction
  onCreate: (initGit: boolean) => Promise<void>
}) {
  const [prompt, setPrompt] = useState<{ hasGit: boolean } | null>(null)
  const t = useT()
  const createLabel = hasGit ? t('worktree.create') : t('worktree.initGit')

  const prepareCreation = async () => {
    const info = await api.worktreeCreateInfo(projectCwd)
    if (info.hasHead) {
      await onCreate(false)
      return
    }
    setPrompt({ hasGit: info.hasGit })
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              sidebarButtonSurface,
              'text-muted-foreground',
              !busy &&
                'pointer-events-none opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
            )}
            aria-label={createLabel}
            disabled={disabled}
            aria-busy={busy}
            onClick={() => void runAction('create-worktree', prepareCreation)}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : hasGit ? <Plus /> : <GitBranch />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{createLabel}</TooltipContent>
      </Tooltip>
      <Dialog
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open) setPrompt(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {prompt?.hasGit ? t('worktree.emptyPrompt') : t('worktree.initPrompt')}
            </DialogTitle>
            <DialogDescription>{t('worktree.emptyNote')}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPrompt(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={disabled}
              onClick={() => {
                const initGit = prompt !== null && !prompt.hasGit
                setPrompt(null)
                void runAction('create-worktree', () => onCreate(initGit))
              }}
            >
              {prompt?.hasGit ? t('worktree.createEmpty') : t('worktree.initAndCreate')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function WorktreeDeleteButton({
  branch,
  projectCwd,
  cwd,
  disabled,
  busy,
  runAction,
  onConfirm
}: {
  branch: string
  projectCwd: string
  cwd: string
  disabled: boolean
  busy: boolean
  runAction: RunProjectAction
  onConfirm: () => Promise<void>
}) {
  // The dialog only describes what gets lost; the confirm button always deletes.
  const [prompt, setPrompt] = useState<{ title: string; body: string } | null>(null)
  const t = useT()
  const confirm = async () => {
    setPrompt(null)
    await onConfirm()
  }

  const prepareDeletion = async () => {
    const info = await api.worktreeDeletionInfo(projectCwd, cwd)
    setPrompt({
      title: info.unmerged
        ? t('worktree.deleteTitleUnmerged', { branch })
        : t('worktree.deleteTitle', { branch }),
      body: info.unmerged
        ? (info.dirty ? t('worktree.deleteBodyUnmergedDirty') : t('worktree.deleteBodyUnmerged'))
        : info.dirty
          ? t('worktree.deleteBodyDirty')
          : info.missing
            ? t('worktree.deleteBodyMissing')
            : t('worktree.deleteBodyClean')
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          'pointer-events-none text-muted-foreground opacity-0 transition-opacity group-hover/worktree:pointer-events-auto group-hover/worktree:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:text-destructive',
          sidebarButtonSurface
        )}
        aria-label={t('worktree.deleteAria', { branch })}
        disabled={disabled}
        aria-busy={busy}
        onClick={() => void runAction(`delete:${cwd}`, prepareDeletion)}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
      </Button>
      <Dialog
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open) setPrompt(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">{prompt?.title}</DialogTitle>
            <DialogDescription className="text-xs">{prompt?.body}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPrompt(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => void runAction(`delete:${cwd}`, confirm)}
            >
              {t('common.delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
