import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ListTree, PenLine } from 'lucide-react'
import type { MessageKey } from '../../../shared/i18n'
import { api, type SessionTreeRow, type SessionTreeView } from '../ipc/api'
import { useSessionsStore, selectActiveSessionId } from '../stores/sessions'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from './ui/context-menu'
import { SessionRenameField } from './SessionRenameField'
import { GooeyNav } from './ui/gooey-nav'
import { SmoothHoverHighlight } from './ui/smooth-hover-highlight'
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

const treeViews: { value: SessionTreeView; labelKey: MessageKey }[] = [
  { value: 'default', labelKey: 'tree.viewDefault' },
  { value: 'no-tools', labelKey: 'tree.viewNoTools' },
  { value: 'user-only', labelKey: 'tree.viewUser' },
  { value: 'labeled-only', labelKey: 'tree.viewLabeled' },
  { value: 'all', labelKey: 'tree.viewAll' }
]

// The tree list mounts only the rows its window can show. The height is fixed so the scroll math
// can be plain arithmetic: every row carries `h-6.5` (26px) below and these two must stay in step.
const ROW_H = 26
const OVERSCAN = 8

function scheduleIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => callback())
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(callback, 150)
  return () => window.clearTimeout(id)
}

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
  const t = useT()
  const activeSessionId = useSessionsStore(selectActiveSessionId)
  const activePath = useSessionsStore((state) => {
    const tab = state.openTabs.find((item) => item.id === state.activeTabId)
    return tab?.meta?.path
  })
  const viewBranch = useSessionsStore((s) => s.viewBranch)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<SessionTreeView>('default')
  const [labelingId, setLabelingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Views arrive default-first: the first paint ships one view over IPC, the rest follow when idle.
  const [trees, setTrees] = useState<Partial<Record<SessionTreeView, SessionTreeRow[]>> | null>(null)
  const treesRef = useRef(trees)
  treesRef.current = trees
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  // Every tree read bumps this: a slower read that lands after a newer one must not paint over it.
  const readGen = useRef(0)

  useEffect(() => {
    if (!open || !activeSessionId) return
    const gen = ++readGen.current
    let cancelled = false
    let unfill: (() => void) | undefined
    setTrees(null)
    setFolded(new Set())
    setError(null)
    setLabelingId(null)
    void api
      .getSessionTrees(activeSessionId, ['default'])
      .then((first) => {
        if (cancelled || readGen.current !== gen || !first) return
        setTrees((prev) => ({ ...prev, ...first }))
        // The dialog is already usable: fill the other tabs off the critical path.
        unfill = scheduleIdle(() => {
          if (cancelled || readGen.current !== gen) return
          void api
            .getSessionTrees(activeSessionId)
            .then((rest) => {
              if (!cancelled && readGen.current === gen && rest) {
                setTrees((prev) => ({ ...prev, ...rest }))
              }
            })
            .catch((reason: unknown) => {
              if (!cancelled && readGen.current === gen) {
                setError(reason instanceof Error ? reason.message : String(reason))
              }
            })
        })
      })
      .catch((reason: unknown) => {
        if (!cancelled && readGen.current === gen) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      cancelled = true
      unfill?.()
    }
  }, [open, activeSessionId])

  // A tab clicked before the idle fill asks for its own view instead of waiting.
  const ensureView = (next: SessionTreeView) => {
    if (!activeSessionId || treesRef.current?.[next]) return
    const gen = readGen.current
    void api
      .getSessionTrees(activeSessionId, [next])
      .then((part) => {
        if (readGen.current === gen && part) setTrees((prev) => ({ ...prev, ...part }))
      })
      .catch((reason: unknown) => {
        if (readGen.current === gen) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
  }

  const rows = trees?.[view] ?? []

  const parentById = useMemo(() => new Map(rows.map((row) => [row.id, row.parentId])), [rows])
  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => {
    return rows.filter((row) => {
      if (
        needle &&
        !row.text.toLowerCase().includes(needle) &&
        !row.label?.toLowerCase().includes(needle)
      ) {
        return false
      }
      if (!needle && isFoldedAway(row, parentById, folded)) return false
      return true
    })
  }, [rows, needle, parentById, folded])

  const multipleRoots = rows.some((row) => row.isVirtualRootChild)

  // A folded or filtered list can leave the recorded offset past the end; clamping here keeps the
  // window from emptying out for the frame before the browser reports the new scrollTop.
  const viewport = viewportH || ROW_H * 12
  const top = Math.min(scrollTop, Math.max(0, visible.length * ROW_H - viewport))
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
  const last = Math.min(visible.length, Math.ceil((top + viewport) / ROW_H) + OVERSCAN)
  const windowRows = visible.slice(first, last)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!open || !list) return
    // Clamping the virtual window alone does not move the real viewport after filtering/folding.
    list.scrollTop = top
    if (scrollTop !== top) setScrollTop(top)
  }, [open, top, scrollTop])

  const startLabel = (id: string) => {
    // A menu holds its focus trap until a tick after it closes. The field has to mount behind that,
    // or the trap pulls the caret back out of it and the field sits there unable to be typed into.
    setTimeout(() => setLabelingId(id), 0)
  }

  const commitLabel = (targetId: string, label: string) => {
    setLabelingId(null)
    if (!activeSessionId) return
    const gen = ++readGen.current
    void api
      .setSessionLabel(activeSessionId, targetId, label, activePath)
      .then(() => api.getSessionTrees(activeSessionId))
      .then((all) => {
        if (readGen.current === gen && all) setTrees(all)
      })
      .catch((reason: unknown) => {
        if (readGen.current === gen) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
  }

  useEffect(() => {
    const list = listRef.current
    if (!open || !list) return
    const measure = (): void => setViewportH(list.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [open])

  // The current row is often outside the mounted window, so scrollIntoView has nothing to find:
  // its offset is arithmetic now. Same trigger as before, so folding or searching does not jump.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!open || !list) return
    const index = visible.findIndex((row) => row.current)
    const height = list.clientHeight || viewportH || ROW_H * 12
    const target = index < 0 ? 0 : Math.min(
      Math.max(0, index * ROW_H - (height - ROW_H) / 2),
      Math.max(0, visible.length * ROW_H - height)
    )
    list.scrollTop = target
    list.scrollLeft = 0
    setScrollTop(target)
  }, [open, rows, view])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setView('default')
        else {
          setQuery('')
          setLabelingId(null)
        }
      }}
    >
      <DialogTrigger asChild>
        <InputGroupButton size="icon-xs" className="rounded-full [&_svg:not([class*='size-'])]:size-3" disabled={disabled} aria-label={t('tree.buttonAria')} title={t('tree.buttonAria')}>
          <ListTree />
        </InputGroupButton>
      </DialogTrigger>
      <DialogContent
        className="max-h-[80vh] sm:max-w-3xl"
        showCloseButton
        // The menu's own layer listens for Escape on the document capture phase, ahead of the field:
        // while a label is being edited Escape cancels the edit instead of closing the dialog.
        onEscapeKeyDown={(event) => {
          if (labelingId !== null) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('tree.buttonAria')}</DialogTitle>
          <DialogDescription>{t('tree.description')}</DialogDescription>
        </DialogHeader>
        <GooeyNav
          size="xs"
          items={treeViews.map((item) => t(item.labelKey))}
          value={treeViews.findIndex((item) => item.value === view)}
          onChange={(index) => {
            // pi clears its folds on every filter change; the rows below are already here.
            const mode = treeViews[index].value
            setView(mode)
            setFolded(new Set())
            ensureView(mode)
          }}
          aria-label={t('tree.viewAria')}
        />
        <Input
          value={query}
          placeholder={t('tree.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div
          ref={listRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="h-[52vh] overflow-auto font-mono text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : !trees?.[view] ? (
            <div className="py-8 text-center text-muted-foreground">{t('tree.loading')}</div>
          ) : visible.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">{t('tree.empty')}</div>
          ) : (
            <SmoothHoverHighlight className="overflow-y-clip" highlightClassName="rounded-none bg-glass-prompt-foreground/8 solid:bg-accent">
              <div style={{ height: first * ROW_H }} />
              {windowRows.map((row) => {
                const collapsed = folded.has(row.id)
                return (
                  <ContextMenu key={row.id}>
                    <ContextMenuTrigger asChild disabled={labelingId === row.id}>
                      <div
                        data-hover-highlight-row
                        className={cn(
                          'relative flex h-6.5 min-w-0 items-center',
                          row.current && 'bg-glass-prompt-foreground/12 text-glass-prompt-foreground solid:bg-accent solid:text-accent-foreground'
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
                            className="shrink-0 hover:bg-transparent!"
                            aria-label={collapsed ? t('tree.expand') : t('tree.collapse')}
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
                        {labelingId === row.id ? (
                          <SessionRenameField
                            value={row.label ?? ''}
                            onCommit={(label) => commitLabel(row.id, label)}
                            onCancel={() => setLabelingId(null)}
                            className="mx-1 flex-1"
                            ariaLabel={t('tree.label')}
                          />
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            className={cn(
                              'h-auto min-w-0 flex-1 justify-start truncate rounded-none px-1 py-0.5 text-left text-xs font-normal hover:bg-transparent!',
                              !row.current && kindClass(row.kind)
                            )}
                            onClick={() => {
                              if (!activeSessionId) return
                              viewBranch(activeSessionId, row.id, { restoreUserInput: true }).then(
                                () => setOpen(false),
                                (reason: unknown) =>
                                  setError(reason instanceof Error ? reason.message : String(reason))
                              )
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {row.onPath ? '• ' : ''}
                              {row.text}
                            </span>
                            {row.label ? (
                              <Badge variant="secondary" className="ml-1.5 h-4 max-w-40 min-w-0 px-1.5 text-[10px] leading-4 font-normal" title={row.label}>
                                <span className="truncate">{row.label}</span>
                              </Badge>
                            ) : null}
                          </Button>
                        )}
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => startLabel(row.id)}>
                        <PenLine data-icon="inline-start" />
                        {t('tree.label')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
              <div style={{ height: (visible.length - last) * ROW_H }} />
            </SmoothHoverHighlight>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {visible.length}/{rows.length}
        </div>
      </DialogContent>
    </Dialog>
  )
}
