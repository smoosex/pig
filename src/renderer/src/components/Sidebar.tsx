import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, FolderMinus, FolderPlus, MoreHorizontal, Plus, Settings, Trash2 } from 'lucide-react'
import { useSessionsStore, type ProjectGroup, type SessionMeta } from '../stores/sessions'
import { api } from '../ipc/api'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
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
    <div className={cn('sticky z-10 flex h-8 shrink-0 items-center gap-0.5 bg-card px-1', className)}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-background"
        onClick={onToggle}
      >
        <ChevronRight
          className={cn('size-2.5 shrink-0 transition-transform', !collapsed && 'rotate-90')}
        />
        <span className="truncate">{label}</span>
      </button>
      {action}
    </div>
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
            <CollapsibleTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                className="group flex h-9 cursor-pointer items-center gap-0.5 rounded-md px-1 transition-colors hover:bg-background"
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.currentTarget.click()
                  }
                }}
              >
                <div className="flex min-w-0 basis-0 flex-1 items-center gap-1.5 rounded-md px-1 text-sm font-normal">
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
                </div>
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
            </CollapsibleTrigger>
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
  const streaming = useSessionsStore((s) => s.runtime[session.id]?.isStreaming ?? false)
  return (
    <div className="group/session ml-6 pr-1 flex min-w-0 items-center gap-0.5 rounded-sm transition-colors hover:bg-background focus-within:bg-background">
      <Button
        variant="ghost"
        size="xs"
        className="h-7 min-w-0 flex-1 justify-start rounded-md text-left text-xs font-normal !bg-transparent"
        title={session.firstMessage}
        onClick={() => void openExisting(session)}
      >
        <span className="min-w-0 truncate">{session.name || session.firstMessage || '(空会话)'}</span>
      </Button>
      {streaming ? <SquaresSpinner /> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="pointer-events-none opacity-0 transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
            aria-label={`会话 ${session.name || session.firstMessage || '空会话'} 更多操作`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 data-icon="inline-start" />
              删除会话
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
  const streaming = useSessionsStore((s) => s.runtime[session.id]?.isStreaming ?? false)
  return (
    <div className="group/chat flex min-w-0 items-center gap-0.5 rounded-sm px-1 pr-1 transition-colors hover:bg-background focus-within:bg-background">
      <Button
        variant="ghost"
        size="xs"
        className="h-7 min-w-0 flex-1 justify-start rounded-md text-left text-xs font-normal !bg-transparent"
        title={title}
        onClick={() => void openExisting(session)}
      >
        <span className="min-w-0 truncate">{title}</span>
      </Button>
      {streaming ? <SquaresSpinner /> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="pointer-events-none opacity-0 transition-opacity group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
            aria-label={`对话 ${title} 更多操作`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onSelect={() => void deleteChat(cwd)}>
              <Trash2 data-icon="inline-start" />
              删除对话
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
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
    <aside className="flex w-62 shrink-0 flex-col pl-2">
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:hidden">
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
        {projectsCollapsed ? null : <ProjectList />}
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
              className="!bg-transparent"
              aria-label="新建对话"
              onClick={() => void newChat()}
            >
              <Plus />
            </Button>
          }
        />
        {chatsCollapsed ? null : <ChatList />}
      </ScrollArea>
      <div className="flex shrink-0 items-center gap-0.5 px-1 pb-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <Settings />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="打开项目"
          onClick={() => void openProject()}
        >
          <FolderPlus />
        </Button>
      </div>
    </aside>
  )
}
