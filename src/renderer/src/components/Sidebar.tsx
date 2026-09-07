import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ChevronRight, FolderMinus, FolderPlus, GitBranch, LoaderCircle, LockKeyhole, MoreHorizontal, Plus, Settings, Trash2 } from 'lucide-react'
import { useSessionsStore, type ProjectGroup, type SessionMeta, type WorktreeGroup } from '../stores/sessions'
import { api } from '../ipc/api'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import { DeleteButton } from './ui/delete-button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'
import { SquaresSpinner } from './RunningSpinners'

const projectAvatarBg = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const

function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function chatTitle(group: ProjectGroup): string {
  const session = group.sessions[0]
  return session?.name || session?.firstMessage || '新对话'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type RunProjectAction = (action: string, run: () => Promise<unknown>) => Promise<void>

function useProjectAction() {
  const pendingRef = useRef(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runAction: RunProjectAction = async (action, run) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(action)
    setError(null)
    try {
      await run()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }
  return { pending, error, runAction }
}

function SectionHeader({
  label,
  collapsed,
  onToggle,
  action,
  className
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('sticky z-10 shrink-0 bg-sidebar px-1', className)}>
      <div className="group/header flex h-8 items-center gap-0.5 rounded-md px-1 hover:bg-sidebar-accent">
        <Button
          variant="ghost"
          className="h-full min-w-0 flex-1 justify-start gap-1 rounded-md px-0 text-xs font-normal text-muted-foreground !bg-transparent"
          onClick={onToggle}
        >
          <ChevronRight
            className={cn('size-2.5 shrink-0 transition-transform', !collapsed && 'rotate-90')}
          />
          <span className="truncate">{label}</span>
        </Button>
        {action}
      </div>
    </div>
  )
}

function CreateWorktreeButton({
  projectCwd,
  hasGit,
  disabled,
  busy,
  onCreate
}: {
  projectCwd: string
  hasGit: boolean
  disabled: boolean
  busy: boolean
  onCreate: (initGit: boolean) => Promise<void>
}) {
  const [prompt, setPrompt] = useState<{ hasGit: boolean } | null>(null)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          '!bg-transparent',
          !busy && 'pointer-events-none opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
        )}
        aria-label="创建 worktree"
        title="创建 worktree"
        disabled={disabled}
        aria-busy={busy}
        onClick={() => void (async () => {
          try {
            const info = await api.worktreeCreateInfo(projectCwd)
            if (info.hasHead) {
              await onCreate(false)
              return
            }
            setPrompt({ hasGit: info.hasGit })
          } catch {
            await onCreate(false)
          }
        })()}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : hasGit ? <Plus /> : <GitBranch />}
      </Button>
      <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open) setPrompt(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {prompt?.hasGit ? '此仓库尚无提交，创建空 Worktree？' : '此项目没有 Git，先初始化？'}
            </DialogTitle>
            <DialogDescription>
              不会提交项目文件。由于没有初始提交，将创建空的孤立分支；原目录中的未提交文件不会复制到 Worktree。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPrompt(null)}>取消</Button>
            <Button
              disabled={disabled}
              onClick={() => {
                const initGit = prompt !== null && !prompt.hasGit
                setPrompt(null)
                void onCreate(initGit)
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

function WorktreeDeleteButton({
  branch,
  projectCwd,
  cwd,
  disabled,
  busy,
  onConfirm
}: {
  branch: string
  projectCwd: string
  cwd: string
  disabled: boolean
  busy: boolean
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
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => void (async () => {
                setOpen(false)
                try {
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
                } catch {
                  await confirm(false)
                }
              })()}
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
            <Button variant="outline" onClick={() => setForceOpen(false)}>取消</Button>
            <Button variant="destructive" disabled={disabled} onClick={() => void confirm(true)}>仍然删除</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DeleteConfirmButton({
  ariaLabel,
  onConfirm,
  disabled = false
}: {
  ariaLabel: string
  title: string
  description: string
  onConfirm: () => void
  disabled?: boolean
}) {
  return (
    <DeleteButton
      label={ariaLabel}
      disabled={disabled}
      onConfirm={onConfirm}
      className="shrink-0 opacity-0 transition-opacity group-hover/session:opacity-100 group-hover/chat:opacity-100 focus-within:opacity-100 data-[state=open]:opacity-100"
    />
  )
}

function ProjectList() {
  const projects = useSessionsStore((s) => s.projects)
  const refreshProject = useSessionsStore((s) => s.refreshProject)
  const loadProjects = useSessionsStore((s) => s.loadProjects)
  const [syncError, setSyncError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const refresh = (cwd?: string) => {
      void (cwd ? refreshProject(cwd) : loadProjects()).then(
        () => { if (!disposed) setSyncError(null) },
        (error: unknown) => { if (!disposed) setSyncError(errorMessage(error)) }
      )
    }
    const unsubscribe = api.onProjectsChanged((cwd) => refresh(cwd))
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    refresh()
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshProject, loadProjects])

  return (
    <div className="flex flex-col gap-y-1 py-1">
      {syncError && <p role="alert" className="px-2 py-1 text-xs break-words text-destructive">{syncError}</p>}
      {projects.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">添加项目即可开始</p>
      )}
      {projects.map((project, index) => <ProjectRow key={project.cwd} project={project} index={index} />)}
    </div>
  )
}

function ProjectRow({ project, index }: { project: ProjectGroup; index: number }) {
  const createWorktree = useSessionsStore((s) => s.createWorktree)
  const newSession = useSessionsStore((s) => s.newSession)
  const deleteProject = useSessionsStore((s) => s.deleteProject)
  const unpinProject = useSessionsStore((s) => s.unpinProject)
  const [open, setOpen] = useState(false)
  const [worktreeOpen, setWorktreeOpen] = useState<Record<string, boolean>>({})
  const [deleteOpen, setDeleteOpen] = useState(false)
  const { pending, error, runAction } = useProjectAction()
  const worktrees: WorktreeGroup[] = project.worktrees ?? [{
    cwd: project.cwd,
    branch: project.name,
    isPrimary: true,
    locked: false,
    missing: false,
    managed: false,
    sessions: project.sessions
  }]

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="px-1">
        <div className="group/project flex h-9 items-center gap-0.5 rounded-md px-1 transition-colors hover:bg-sidebar-accent">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="h-full min-w-0 flex-1 justify-start gap-1.5 rounded-md px-0 text-xs font-normal !bg-transparent"
            >
              <Avatar className="size-5 rounded-sm after:rounded-sm">
                <AvatarFallback
                  className={cn(
                    'rounded-sm text-xs font-normal text-primary-foreground',
                    projectAvatarBg[index % projectAvatarBg.length]
                  )}
                >
                  {projectInitial(project.name)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 truncate" title={project.cwd}>{project.name}</span>
              <ChevronRight
                className={cn(
                  'size-2.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/project:opacity-100 group-focus-within/project:opacity-100',
                  open && 'rotate-90'
                )}
              />
            </Button>
          </CollapsibleTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="pointer-events-none opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
                aria-label={`项目 ${project.name} 更多操作`}
                disabled={pending !== null}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={pending !== null}
                  onSelect={() => void runAction('unpin', () => unpinProject(project.cwd))}
                >
                  <FolderMinus data-icon="inline-start" />
                  从列表移除
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={pending !== null}
                  onSelect={() => setDeleteOpen(true)}
                >
                  <Trash2 data-icon="inline-start" />
                  删除项目
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <CreateWorktreeButton
            projectCwd={project.cwd}
            hasGit={project.hasGit === true}
            disabled={pending !== null}
            busy={pending === 'create-worktree'}
            onCreate={(initGit) => runAction('create-worktree', async () => {
              const cwd = await createWorktree(project.cwd, { initGit })
              if (!cwd) return
              setOpen(true)
              setWorktreeOpen((state) => ({ ...state, [cwd]: true }))
              await newSession(cwd)
            })}
          />
        </div>
        {project.gitError && <p role="alert" className="px-1 py-1 text-xs break-words text-destructive">{project.gitError}</p>}
        {error && <p role="alert" className="px-1 py-1 text-xs break-words text-destructive">{error}</p>}
      </div>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">删除项目</DialogTitle>
            <DialogDescription className="text-xs">
              将停止并删除原目录及所有 Worktree 的 Pi 会话，并从项目列表移除。项目文件、Worktree 和 Git 分支会保留。会话删除后无法恢复。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              disabled={pending !== null}
              onClick={() => {
                setDeleteOpen(false)
                void runAction('delete-project', () => deleteProject(project.cwd))
              }}
            >
              删除会话并移除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 pt-0.5 pb-1">
          {worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.cwd}
              projectCwd={project.cwd}
              worktree={worktree}
              open={worktreeOpen[worktree.cwd] ?? false}
              onOpenChange={(value) => setWorktreeOpen((state) => ({ ...state, [worktree.cwd]: value }))}
              pending={pending}
              runAction={runAction}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function WorktreeRow({
  projectCwd,
  worktree,
  open,
  onOpenChange,
  pending,
  runAction
}: {
  projectCwd: string
  worktree: WorktreeGroup
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: string | null
  runAction: RunProjectAction
}) {
  const newSession = useSessionsStore((s) => s.newSession)
  const deleteWorktree = useSessionsStore((s) => s.deleteWorktree)
  const deleteSession = useSessionsStore((s) => s.deleteSession)
  const openExisting = useSessionsStore((s) => s.openExisting)
  const active = useSessionsStore((s) => {
    const tab = s.openTabs.find((item) => item.sessionId === s.activeSessionId)
    return tab?.cwd === worktree.cwd
  })
  const namingLabel = worktree.naming === 'pending' ? '待命名'
    : worktree.naming === 'naming' ? '命名中'
      : worktree.naming === 'failed' ? '命名失败' : null

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="px-1">
        <div className={cn(
          'group/worktree flex h-7 min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors hover:bg-sidebar-accent',
          active && 'bg-sidebar-accent'
        )}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="h-full min-w-0 flex-1 justify-start gap-1 rounded-md px-0 text-xs font-normal !bg-transparent"
              aria-label={`${worktree.branch}${namingLabel ? `，${namingLabel}` : ''}`}
            >
              <ChevronRight
                className={cn(
                  'size-2.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100',
                  open && 'rotate-90'
                )}
              />
              <span className="min-w-0 truncate">{worktree.branch}</span>
              {worktree.locked && <LockKeyhole className="text-muted-foreground" />}
              {worktree.missing && <AlertCircle className="text-destructive" />}
              {namingLabel && (
                <span className={cn('shrink-0 text-muted-foreground', worktree.naming === 'failed' && 'text-destructive')}>
                  {namingLabel}
                </span>
              )}
            </Button>
          </CollapsibleTrigger>
          {!worktree.isPrimary && (
            <WorktreeDeleteButton
              branch={worktree.branch}
              projectCwd={projectCwd}
              cwd={worktree.cwd}
              disabled={pending !== null}
              busy={pending === `delete:${worktree.cwd}`}
              onConfirm={(force) => runAction(`delete:${worktree.cwd}`, () => deleteWorktree(projectCwd, worktree.cwd, force))}
            />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              '!bg-transparent',
              pending !== `new:${worktree.cwd}` && 'pointer-events-none opacity-0 transition-opacity group-hover/worktree:pointer-events-auto group-hover/worktree:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
            )}
            aria-label={`在 ${worktree.branch} 中新建会话`}
            disabled={pending !== null || worktree.missing}
            aria-busy={pending === `new:${worktree.cwd}`}
            onClick={() => void runAction(`new:${worktree.cwd}`, async () => {
              onOpenChange(true)
              await newSession(worktree.cwd)
            })}
          >
            {pending === `new:${worktree.cwd}` ? <LoaderCircle className="animate-spin" /> : <Plus />}
          </Button>
        </div>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 pt-0.5 pb-1">
          {worktree.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              pending={pending !== null}
              onOpen={() => void runAction(`open:${session.id}`, () => openExisting(session))}
              onDelete={() => void runAction(`delete-session:${session.id}`, () => deleteSession(session))}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SessionRow({ session, pending, onOpen, onDelete }: {
  session: SessionMeta
  pending: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const active = useSessionsStore((s) => s.activeSessionId === session.id)
  const streaming = useSessionsStore((s) => s.runtime[session.id]?.isStreaming ?? false)
  const label = session.name || session.firstMessage || '空会话'
  return (
    <div className="ml-6 px-1">
    <div
      className={cn(
        'group/session flex min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent'
      )}
    >
      <Button
        variant="ghost"
        size="xs"
        className="h-7 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal !bg-transparent"
        title={session.firstMessage}
        disabled={pending}
        onClick={onOpen}
      >
        <span className="min-w-0 truncate">{session.name || session.firstMessage || '(空会话)'}</span>
      </Button>
      {streaming ? (
        <SquaresSpinner />
      ) : (
        <DeleteConfirmButton
          ariaLabel={`删除会话 ${label}`}
          title="删除会话"
          description={`确定删除「${label}」？删除后无法恢复。`}
          disabled={pending}
          onConfirm={onDelete}
        />
      )}
    </div>
    </div>
  )
}

function ChatList() {
  const chats = useSessionsStore((s) => s.chats)

  if (chats.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">点击 + 开始对话</p>
  }

  return (
    <div className="flex flex-col gap-0.5 py-1">
      {chats.map((chat) => {
        const session = chat.sessions[0]
        if (!session) return null
        return <ChatRow key={chat.cwd} session={session} title={chatTitle(chat)} cwd={chat.cwd} />
      })}
    </div>
  )
}

function ChatRow({
  session,
  title,
  cwd
}: {
  session: SessionMeta
  title: string
  cwd: string
}) {
  const openExisting = useSessionsStore((s) => s.openExisting)
  const deleteChat = useSessionsStore((s) => s.deleteChat)
  const active = useSessionsStore((s) => s.activeSessionId === session.id)
  const streaming = useSessionsStore((s) => s.runtime[session.id]?.isStreaming ?? false)
  return (
    <div className="px-1">
    <div
      className={cn(
        'group/chat flex min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent'
      )}
    >
      <Button
        variant="ghost"
        size="xs"
        className="h-7 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal !bg-transparent"
        title={title}
        onClick={() => void openExisting(session)}
      >
        <span className="min-w-0 truncate">{title}</span>
      </Button>
      {streaming ? (
        <SquaresSpinner />
      ) : (
        <DeleteConfirmButton
          ariaLabel={`删除对话 ${title}`}
          title="删除对话"
          description={`确定删除「${title}」？删除后无法恢复。`}
          onConfirm={() => void deleteChat(cwd)}
        />
      )}
    </div>
    </div>
  )
}

export function Sidebar({ onOpenSettings, hidden = false }: { onOpenSettings: () => void; hidden?: boolean }) {
  const openProject = useSessionsStore((s) => s.openProject)
  const newChat = useSessionsStore((s) => s.newChat)
  const { pending: projectPending, error: projectError, runAction: runProjectAction } = useProjectAction()
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [chatsCollapsed, setChatsCollapsed] = useState(false)

  useEffect(() => {
    void api.getSidebarPrefs().then((prefs) => {
      setProjectsCollapsed(prefs.projectsCollapsed)
      setChatsCollapsed(prefs.chatsCollapsed)
    })
  }, [])

  return (
    <aside
      inert={hidden}
      aria-hidden={hidden}
      className={cn(
        'flex min-w-0 shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out motion-reduce:transition-none',
        hidden ? 'w-0' : 'w-62'
      )}
    >
      <div className="flex w-62 shrink-0 flex-col pl-2">
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:hidden">
        <div className="pt-1">
        <Collapsible
          open={!projectsCollapsed}
          onOpenChange={(open) => {
            setProjectsCollapsed(!open)
            void api.setSidebarPrefs({ projectsCollapsed: !open })
          }}
        >
          <SectionHeader
            className="top-0"
            label="项目"
            collapsed={projectsCollapsed}
            onToggle={() => {
              const next = !projectsCollapsed
              setProjectsCollapsed(next)
              void api.setSidebarPrefs({ projectsCollapsed: next })
            }}
          />
          <CollapsibleContent>
            <ProjectList />
          </CollapsibleContent>
        </Collapsible>
        <Collapsible
          open={!chatsCollapsed}
          onOpenChange={(open) => {
            setChatsCollapsed(!open)
            void api.setSidebarPrefs({ chatsCollapsed: !open })
          }}
        >
          <SectionHeader
            className="top-8"
            label="对话"
            collapsed={chatsCollapsed}
            onToggle={() => {
              const next = !chatsCollapsed
              setChatsCollapsed(next)
              void api.setSidebarPrefs({ chatsCollapsed: next })
            }}
            action={
              <Button
                variant="ghost"
                size="icon-xs"
                className="pointer-events-none opacity-0 transition-opacity group-hover/header:pointer-events-auto group-hover/header:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
                aria-label="新建对话"
                onClick={() => void newChat()}
              >
                <Plus />
              </Button>
            }
          />
          <CollapsibleContent>
            <ChatList />
          </CollapsibleContent>
        </Collapsible>
        </div>
      </ScrollArea>
      {projectError && <p role="alert" className="px-2 py-1 text-xs break-words text-destructive">{projectError}</p>}
      <div className="flex shrink-0 items-center gap-0.5 px-1 pb-2">
        <Tooltip>
        <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <Settings />
        </Button>
        </TooltipTrigger>
        <TooltipContent>设置 <Kbd className="bg-transparent!">⌘ ,</Kbd></TooltipContent>
        </Tooltip>
        <Tooltip>
        <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="打开项目"
          disabled={projectPending !== null}
          aria-busy={projectPending !== null}
          onClick={() => void runProjectAction('open-project', openProject)}
        >
          <FolderPlus />
        </Button>
        </TooltipTrigger>
        <TooltipContent>添加项目 <Kbd className="bg-transparent!">⌘ ⇧ A</Kbd></TooltipContent>
        </Tooltip>
      </div>
      </div>
    </aside>
  )
}
