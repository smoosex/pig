import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Empty, EmptyDescription } from './ui/empty'
import { ScrollArea } from './ui/scroll-area'

export function Sidebar() {
  const projects = useSessionsStore((s) => s.projects)
  const openExisting = useSessionsStore((s) => s.openExisting)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <aside className="flex w-60 shrink-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1.5">
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
                  className="mb-0.5"
                >
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 w-full justify-start gap-1 rounded-none px-3 text-left font-normal">
                      {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                      <span className="min-w-0 flex-1 truncate" title={p.cwd}>
                        {p.name}
                      </span>
                      <Badge variant="ghost" className="ml-auto px-1 text-muted-foreground">
                        {p.sessions.length}
                      </Badge>
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {p.sessions.map((s) => (
                      <Button
                        key={s.id}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-full justify-start truncate rounded-none pl-6.5 text-left text-xs font-normal text-muted-foreground"
                        title={s.firstMessage}
                        onClick={() => void openExisting(s)}
                      >
                        {s.name || s.firstMessage || '(空会话)'}
                      </Button>
                    ))}
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
