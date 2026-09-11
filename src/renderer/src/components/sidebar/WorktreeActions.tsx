import { useState } from 'react'
import { GitBranch, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { api } from '../../ipc/api'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
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
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          '!bg-transparent',
          !busy &&
            'pointer-events-none opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
        )}
        aria-label="创建 worktree"
        title="创建 worktree"
        disabled={disabled}
        aria-busy={busy}
        onClick={() => void runAction('create-worktree', prepareCreation)}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : hasGit ? <Plus /> : <GitBranch />}
      </Button>
      <Dialog
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open) setPrompt(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {prompt?.hasGit ? '此仓库尚无提交，创建空 Worktree？' : '此项目没有 Git，先初始化？'}
            </DialogTitle>
            <DialogDescription>
              不会提交项目文件。由于没有初始提交，将创建空的孤立分支；原目录中的未提交文件不会复制到
              Worktree。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPrompt(null)}>
              取消
            </Button>
            <Button
              disabled={disabled}
              onClick={() => {
                const initGit = prompt !== null && !prompt.hasGit
                setPrompt(null)
                void runAction('create-worktree', () => onCreate(initGit))
              }}
            >
              {prompt?.hasGit ? '创建空 Worktree' : '初始化并创建'}
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
  onConfirm: (force: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const confirm = async (force: boolean) => {
    setOpen(false)
    setForceOpen(false)
    await onConfirm(force)
  }

  const prepareDeletion = async () => {
    setOpen(false)
    const info = await api.worktreeDeletionInfo(projectCwd, cwd)
    const next = [
      info.dirty ? '包含未提交、未跟踪或被忽略的文件。' : null,
      info.unmerged ? '分支含有尚未合入原项目的提交。' : null,
      info.missing ? '工作目录已丢失，将清理剩余注册和会话。' : null
    ].filter((item): item is string => item !== null)
    if (next.length > 0) {
      setWarnings(next)
      setForceOpen(true)
      return
    }
    await confirm(false)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className="pointer-events-none text-muted-foreground opacity-0 transition-opacity group-hover/worktree:pointer-events-auto group-hover/worktree:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:text-destructive !bg-transparent"
        aria-label={`删除 ${branch}`}
        disabled={disabled}
        aria-busy={busy}
        onClick={() => setOpen(true)}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">删除分支</DialogTitle>
            <DialogDescription className="text-xs">
              将停止该目录的会话，删除工作目录、对应 Git 分支和 Pi 会话文件，无法撤销。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => void runAction(`delete:${cwd}`, prepareDeletion)}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={forceOpen} onOpenChange={setForceOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">删除分支</DialogTitle>
            <DialogDescription className="text-xs">
              {warnings.join('')}这些内容和对应会话将被永久删除。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForceOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => void runAction(`delete:${cwd}`, () => confirm(true))}
            >
              仍然删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
