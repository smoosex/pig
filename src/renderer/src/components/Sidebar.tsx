import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, FolderMinus, FolderPlus, MoreHorizontal, Plus, Settings, Trash2 } from 'lucide-react'
import { useSessionsStore, type ProjectGroup, type SessionMeta } from '../stores/sessions'
import { api } from '../ipc/api'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
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

function DeleteConfirmButton({
  ariaLabel,
  title,
  description,
  onConfirm
}: {
  ariaLabel: string
  title: string
  description: string
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className="pointer-events-none text-muted-foreground opacity-0 transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:text-destructive !bg-transparent"
        aria-label={ariaLabel}
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <Trash2 />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ProjectList() {
  const projects = useSessionsStore((s) => s.projects)
  const newSession = useSessionsStore((s) => s.newSession)
  const deleteProject = useSessionsStore((s) => s.deleteProject)
  const deleteSession = useSessionsStore((s) => s.deleteSession)
  const unpinProject = useSessionsStore((s) => s.unpinProject)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  if (projects.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">添加项目即可开始</p>
  }

  return (
    <div className="flex flex-col gap-y-1 py-1">
      {projects.map((p, index) => {
        const isCollapsed = collapsed[p.cwd] ?? true
        return (
          <Collapsible
            key={p.cwd}
            open={!isCollapsed}
            onOpenChange={(open) => setCollapsed((c) => ({ ...c, [p.cwd]: !open }))}
          >
            <div className="px-1">
            <div className="group flex h-9 items-center gap-0.5 rounded-md px-1 transition-colors hover:bg-sidebar-accent">
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
                      {projectInitial(p.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 truncate text-xs font-normal" title={p.cwd}>
                    {p.name}
                  </span>
                  <ChevronRight
                    className={cn(
                      'size-2.5 shrink-0 text-muted-foreground transition-transform',
                      !isCollapsed && 'rotate-90'
                    )}
                  />
                </Button>
              </CollapsibleTrigger>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
                      aria-label={`项目 ${p.name} 更多操作`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => void unpinProject(p.cwd)}>
                        <FolderMinus data-icon="inline-start" />
                        从列表移除
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => void deleteProject(p.cwd)}
                      >
                        <Trash2 data-icon="inline-start" />
                        删除项目
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="!bg-transparent"
                  aria-label={`在 ${p.name} 中新建会话`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void newSession(p.cwd)
                  }}
                >
                  <Plus />
                </Button>
            </div>
            </div>
            <CollapsibleContent>
              <div className="flex flex-col gap-0.5 pb-1">
                {p.sessions.map((s) => (
                  <SessionRow key={s.id} session={s} onDelete={() => void deleteSession(s)} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}

function SessionRow({ session, onDelete }: { session: SessionMeta; onDelete: () => void }) {
  const openExisting = useSessionsStore((s) => s.openExisting)
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
        onClick={() => void openExisting(session)}
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
          onClick={() => void openProject()}
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
