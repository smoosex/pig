import { useState } from 'react'
import { ChevronRight, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
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
import { Empty, EmptyDescription } from './ui/empty'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'

function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

export function Sidebar() {
  const projects = useSessionsStore((s) => s.projects)
  const openExisting = useSessionsStore((s) => s.openExisting)
  const newSession = useSessionsStore((s) => s.newSession)
  const deleteProject = useSessionsStore((s) => s.deleteProject)
  const deleteSession = useSessionsStore((s) => s.deleteSession)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <aside className="flex w-62 shrink-0 flex-col pl-2">
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:hidden">
        <div className="flex flex-col gap-y-1 py-1.5">
          {projects.length === 0 ? (
            <Empty className="min-h-24 p-3">
              <EmptyDescription>暂无历史会话</EmptyDescription>
            </Empty>
          ) : (
            projects.map((p) => {
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
                          <AvatarFallback className="rounded-sm bg-chart-5 text-xs font-normal text-primary-foreground">
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
                        <div
                          key={s.id}
                          className="group/session ml-6 pr-1 flex min-w-0 items-center gap-0.5 rounded-sm transition-colors hover:bg-background focus-within:bg-background"
                        >
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-7 min-w-0 flex-1 justify-start rounded-md text-left text-xs font-normal text-muted-foreground !bg-transparent"
                            title={s.firstMessage}
                            onClick={() => void openExisting(s)}
                          >
                            <span className="min-w-0 truncate">
                              {s.name || s.firstMessage || '(空会话)'}
                            </span>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="pointer-events-none opacity-0 transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
                                aria-label={`会话 ${s.name || s.firstMessage || '空会话'} 更多操作`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => void deleteSession(s)}
                                >
                                  <Trash2 data-icon="inline-start" />
                                  删除会话
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            })
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}
