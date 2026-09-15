import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import { api, type SessionTreeRow } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from './ui/dialog'
import { Input } from './ui/input'
import { InputGroupButton } from './ui/input-group'

const toolbarBtn =
  "h-6 rounded-full px-2 text-xs font-light [&_svg:not([class*='size-'])]:size-3"

function kindClass(kind: SessionTreeRow['kind']): string {
  if (kind === 'user') return 'text-primary'
  if (kind === 'assistant') return 'text-foreground'
  return 'text-muted-foreground'
}

function treePrefix(row: SessionTreeRow, multipleRoots: boolean): string {
  const displayIndent = multipleRoots ? Math.max(0, row.indent - 1) : row.indent
  const connector = row.showConnector && !row.isVirtualRootChild
  const connectorPosition = connector ? displayIndent - 1 : -1
  const chars: string[] = []
  const totalChars = displayIndent * 3
  for (let i = 0; i < totalChars; i++) {
    const level = Math.floor(i / 3)
    const posInLevel = i % 3
    const gutter = row.gutters.find((item) => item.position === level)
    if (gutter) {
      chars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ')
    } else if (connector && level === connectorPosition) {
      if (posInLevel === 0) chars.push(row.isLast ? '└' : '├')
      else if (posInLevel === 1) chars.push('─')
      else chars.push(' ')
    } else {
      chars.push(' ')
    }
  }
  return chars.join('')
}

function isFoldedAway(
  row: SessionTreeRow,
  parentById: Map<string, string | null>,
  folded: Set<string>
): boolean {
  let id = row.parentId
  while (id) {
    if (folded.has(id)) return true
    id = parentById.get(id) ?? null
  }
  return false
}

export function SessionTreeButton({ disabled }: { disabled?: boolean }) {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const viewBranch = useSessionsStore((s) => s.viewBranch)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<SessionTreeRow[]>([])
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const currentRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open || !activeSessionId) return
    let cancelled = false
    setRows([])
    setFolded(new Set())
    setError(null)
    void api
      .getSessionTree(activeSessionId)
      .then((tree) => {
        if (!cancelled) setRows(Array.isArray(tree) ? tree : [])
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [open, activeSessionId])

  const parentById = useMemo(() => new Map(rows.map((row) => [row.id, row.parentId])), [rows])
  const multipleRoots = rows.some((row) => row.isVirtualRootChild)
  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => {
    return rows.filter((row) => {
      if (needle && !row.text.toLowerCase().includes(needle)) return false
      if (!needle && isFoldedAway(row, parentById, folded)) return false
      return true
    })
  }, [rows, needle, parentById, folded])

  useEffect(() => {
    if (!open) return
    currentRef.current?.scrollIntoView({ block: 'center' })
  }, [open, rows])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <DialogTrigger asChild>
        <InputGroupButton className={toolbarBtn} disabled={disabled} aria-label="会话树">
          <GitBranch data-icon="inline-start" />
          树
        </InputGroupButton>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] sm:max-w-3xl" showCloseButton>
        <DialogHeader>
          <DialogTitle>Session Tree</DialogTitle>
          <DialogDescription>选择任意节点，从那里继续对话。</DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          placeholder="搜索节点"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="max-h-[52vh] overflow-auto font-mono text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : visible.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">没有节点</div>
          ) : (
            visible.map((row) => {
              const collapsed = folded.has(row.id)
              return (
                <div
                  key={row.id}
                  className={cn(
                    'flex min-w-0 items-center',
                    row.current && 'bg-accent text-accent-foreground'
                  )}
                >
                  <span className="shrink-0 whitespace-pre text-muted-foreground">
                    {treePrefix(row, multipleRoots)}
                  </span>
                  {row.foldable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0"
                      aria-label={collapsed ? '展开' : '折叠'}
                      onClick={() => {
                        setFolded((current) => {
                          const next = new Set(current)
                          if (next.has(row.id)) next.delete(row.id)
                          else next.add(row.id)
                          return next
                        })
                      }}
                    >
                      <ChevronRight className={cn(!collapsed && 'rotate-90')} />
                    </Button>
                  ) : null}
                  <Button
                    ref={row.current ? currentRef : undefined}
                    type="button"
                    variant="ghost"
                    className={cn(
                      'h-auto min-w-0 flex-1 justify-start truncate rounded-none px-1 py-0.5 text-left text-xs font-normal',
                      !row.current && kindClass(row.kind)
                    )}
                    onClick={() => {
                      if (!activeSessionId) return
                      viewBranch(activeSessionId, row.id).then(
                        () => setOpen(false),
                        (reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : String(reason))
                      )
                    }}
                  >
                    {row.onPath ? '• ' : ''}
                    {row.text}
                  </Button>
                </div>
              )
            })
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {visible.length}/{rows.length}
        </div>
      </DialogContent>
    </Dialog>
  )
}
