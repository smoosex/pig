import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, CornerDownRight, ListCollapse, ListTree, LoaderCircle, MessageSquareText, PenLine } from 'lucide-react'
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
  ContextMenuSeparator,
  ContextMenuTrigger
} from './ui/context-menu'
import { SessionRenameField } from './SessionRenameField'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { SmoothHoverHighlight } from './ui/smooth-hover-highlight'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from './ui/dialog'
import { Alert, AlertDescription } from './ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Textarea } from './ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Input } from './ui/input'
import { InputGroupButton } from './ui/input-group'

const treeViews: { value: SessionTreeView; labelKey: MessageKey }[] = [
  { value: 'default', labelKey: 'tree.viewDefault' },
  { value: 'no-tools', labelKey: 'tree.viewNoTools' },
  { value: 'user-only', labelKey: 'tree.viewUser' },
  { value: 'labeled-only', labelKey: 'tree.viewLabeled' },
  { value: 'all', labelKey: 'tree.viewAll' }
]

type BranchTarget = { sessionId: string; tipId: string }
type BranchMode = 'none' | 'summary' | 'custom'

// The tree list mounts only the rows its window can show. The height is fixed so the scroll math
// can be plain arithmetic: every row carries `h-6.5` (26px) below and these two must stay in step.
const ROW_H = 26
const OVERSCAN = 8

function kindClass(kind: SessionTreeRow['kind']): string {
  if (kind === 'user') return 'text-primary'
  if (kind === 'assistant') return 'text-foreground'
  return 'text-muted-foreground'
}

// Deep forks would otherwise spend the whole row on gutters. Past MAX_DEPTH the leftmost levels are
// dropped in DEPTH_STEP chunks: rows within one chunk keep their relative indent, and only a chunk
// boundary shifts the drawing left.
const MAX_DEPTH = 6
// Rows sit back to back; a short delay keeps sweeping the pointer down the list from flashing tips.
const TOOLTIP_DELAY = 300
const DEPTH_STEP = 4

function hiddenDepth(displayIndent: number): number {
  return displayIndent > MAX_DEPTH ? Math.ceil((displayIndent - MAX_DEPTH) / DEPTH_STEP) * DEPTH_STEP : 0
}

function treePrefix(row: SessionTreeRow, multipleRoots: boolean): { hidden: number; text: string } {
  const displayIndent = multipleRoots ? Math.max(0, row.indent - 1) : row.indent
  const hidden = hiddenDepth(displayIndent)
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
  const text = chars.slice(hidden * 3).join('')
  return { hidden, text: hidden ? `…+${hidden} ${text}` : text }
}

export function SessionTreeButton({ disabled }: { disabled?: boolean }) {
  const t = useT()
  const activeSessionId = useSessionsStore(selectActiveSessionId)
  const activePath = useSessionsStore((state) => {
    const tab = state.openTabs.find((item) => item.id === state.activeTabId)
    return tab?.meta?.path
  })
  const viewBranch = useSessionsStore((s) => s.viewBranch)
  const navigating = useSessionsStore((s) => !!(activeSessionId && s.runtime[activeSessionId]?.isNavigatingBranch))
  const [open, setOpen] = useState(false)
  // `selection` is the node being switched to (kept after a failure so the error stays attributable);
  // `customTarget` holds a node while the user writes custom summary instructions.
  const [selection, setSelection] = useState<BranchTarget | null>(null)
  const [customTarget, setCustomTarget] = useState<BranchTarget | null>(null)
  const [summaryMode, setSummaryMode] = useState<BranchMode>('none')
  const [instructions, setInstructions] = useState('')
  const [branchError, setBranchError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const pendingRef = useRef(false)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const sessionRef = useRef(activeSessionId)
  sessionRef.current = activeSessionId
  const busy = pending || navigating

  useEffect(() => {
    setSelection(null)
    setCustomTarget(null)
    setBranchError(null)
    setInstructions('')
    setSummaryMode('none')
  }, [activeSessionId])

  const confirmBranch = async (target: BranchTarget, mode: BranchMode, customInstructions?: string) => {
    if (busy || pendingRef.current || sessionRef.current !== target.sessionId) return
    pendingRef.current = true
    selectionRef.current = target
    setSelection(target)
    setPending(true)
    setSummaryMode(mode)
    setStopping(false)
    setBranchError(null)
    try {
      const changed = await viewBranch(target.sessionId, target.tipId, {
        restoreUserInput: true,
        summarize: mode !== 'none',
        ...(mode === 'custom' ? { customInstructions } : {})
      })
      if (changed && sessionRef.current === target.sessionId && selectionRef.current === target) {
        setOpen(false)
        setSelection(null)
        setQuery('')
      }
    } catch (reason: unknown) {
      if (sessionRef.current === target.sessionId && selectionRef.current === target) {
        setBranchError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      pendingRef.current = false
      setPending(false)
      setStopping(false)
    }
  }
  const [view, setView] = useState<SessionTreeView>('default')
  const [labelingId, setLabelingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Load only the selected views; opening a long tree must not build five projections.
  const [trees, setTrees] = useState<Partial<Record<SessionTreeView, SessionTreeRow[]>> | null>(null)
  const treesRef = useRef(trees)
  treesRef.current = trees
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  // The view last centred on its current node; null after each (re)load so the first rows centre once.
  // Later row refreshes (a loaded view, a relabel) must not yank a list the user is scrolling.
  const centeredView = useRef<SessionTreeView | null>(null)
  // The dialog body mounts through a portal a render after `open` flips, so measuring has to follow
  // the element itself rather than an effect keyed on `open`.
  const attachList = useCallback((list: HTMLDivElement | null) => {
    listRef.current = list
    if (!list) return
    const measure = (): void => setViewportH(list.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => {
      observer.disconnect()
      listRef.current = null
    }
  }, [])
  // Every tree read bumps this: a slower read that lands after a newer one must not paint over it.
  const readGen = useRef(0)

  useEffect(() => {
    if (!open || !activeSessionId) return
    const gen = ++readGen.current
    let cancelled = false
    setTrees(null)
    centeredView.current = null
    setFolded(new Set())
    setError(null)
    setLabelingId(null)
    void api
      .getSessionTrees(activeSessionId, ['default'])
      .then((first) => {
        if (cancelled || readGen.current !== gen || !first) return
        setTrees((prev) => ({ ...prev, ...first }))
      })
      .catch((reason: unknown) => {
        if (!cancelled && readGen.current === gen) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, activeSessionId])

  // Each view is fetched on first selection and reused until the tree changes.
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
  // Filtered views keep the closest visible ancestor as their current node.
  const currentRow = rows.find((row) => row.current)
    ?? (view === 'user-only' ? rows.findLast((row) => row.onPath) : undefined)
  const currentRowId = currentRow?.id

  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!needle && folded.size === 0) return rows
    const hidden = new Set<string>()
    return rows.filter((row) => {
      // Rows are preorder: each parent's visibility is known before its children are visited.
      if (!needle && row.parentId && (folded.has(row.parentId) || hidden.has(row.parentId))) {
        hidden.add(row.id)
        return false
      }
      if (
        needle &&
        !row.text.toLowerCase().includes(needle) &&
        !row.label?.toLowerCase().includes(needle)
      ) {
        return false
      }
      return true
    })
  }, [rows, needle, folded])

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
    const loadedViews = Object.keys(treesRef.current ?? {}) as SessionTreeView[]
    void api
      .setSessionLabel(activeSessionId, targetId, label, activePath)
      .then(() => api.getSessionTrees(activeSessionId, loadedViews))
      .then((all) => {
        if (readGen.current === gen && all) setTrees(all)
      })
      .catch((reason: unknown) => {
        if (readGen.current === gen) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
  }

  // The current row is often outside the mounted window, so scrollIntoView has nothing to find:
  // its offset is arithmetic now. Folding or searching does not recentre.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!open || !list || !trees?.[view] || centeredView.current === view) return
    centeredView.current = view
    const index = visible.findIndex((row) => row.id === currentRowId)
    const height = list.clientHeight || viewportH || ROW_H * 12
    const target = index < 0 ? 0 : Math.min(
      Math.max(0, index * ROW_H - (height - ROW_H) / 2),
      Math.max(0, visible.length * ROW_H - height)
    )
    list.scrollTop = target
    list.scrollLeft = 0
    setScrollTop(target)
  }, [open, trees, view, visible, viewportH, currentRowId])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy || pendingRef.current) return
        setOpen(next)
        if (next) setView('default')
        else {
          setQuery('')
          setLabelingId(null)
          setSelection(null)
          setBranchError(null)
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
        showCloseButton={!busy}
        aria-busy={busy}
        onInteractOutside={(event) => {
          if (busy || pendingRef.current) event.preventDefault()
        }}
        // The menu's own layer listens for Escape on the document capture phase, ahead of the field:
        // while a label is being edited Escape cancels the edit instead of closing the dialog.
        onEscapeKeyDown={(event) => {
          if (busy || pendingRef.current || labelingId !== null) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{t('tree.buttonAria')}</DialogTitle>
          <DialogDescription className="text-xs">{t('tree.description')}</DialogDescription>
        </DialogHeader>
        <div inert={busy} className="grid gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0.5}
          size="xs"
          className="justify-self-start"
          value={view}
          onValueChange={(next) => {
            const mode = treeViews.find((item) => item.value === next)?.value
            if (busy || !mode) return
            // pi clears its folds on every filter change; the rows below are already here.
            setView(mode)
            setFolded(new Set())
            ensureView(mode)
          }}
          aria-label={t('tree.viewAria')}
        >
          {treeViews.map((item) => <ToggleGroupItem key={item.value} value={item.value}>{t(item.labelKey)}</ToggleGroupItem>)}
        </ToggleGroup>
        <Input
          value={query}
          disabled={busy}
          placeholder={t('tree.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div
          ref={attachList}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="h-[52vh] overflow-auto font-mono text-xs [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                const prefix = treePrefix(row, multipleRoots)
                return (
                  <ContextMenu key={row.id}>
                    <ContextMenuTrigger asChild disabled={labelingId === row.id}>
                      <div
                        data-hover-highlight-row
                        className={cn(
                          'relative flex h-6.5 min-w-0 items-center',
                          row.id === currentRowId && 'bg-glass-prompt-foreground/12 text-glass-prompt-foreground solid:bg-accent solid:text-accent-foreground'
                        )}
                      >
                        {/* Overflowing flex-end content clips on the left, keeping the levels nearest the node. */}
                        {prefix.hidden ? (
                          <Tooltip delayDuration={TOOLTIP_DELAY}>
                            <TooltipTrigger asChild>
                              <span className="flex max-w-[45%] shrink-0 justify-end overflow-hidden text-muted-foreground">
                                <span className="shrink-0 whitespace-pre">{prefix.text}</span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{t('tree.hiddenDepth', { n: prefix.hidden })}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="flex max-w-[45%] shrink-0 justify-end overflow-hidden text-muted-foreground">
                            <span className="shrink-0 whitespace-pre">{prefix.text}</span>
                          </span>
                        )}
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
                          <Tooltip delayDuration={TOOLTIP_DELAY}>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                className={cn(
                                  'h-auto min-w-0 flex-1 justify-start truncate rounded-none px-1 py-0.5 text-left text-xs font-normal hover:bg-transparent!',
                                  row.id !== currentRowId && kindClass(row.kind)
                                )}
                                aria-current={row.id === currentRowId ? 'true' : undefined}
                                onClick={() => {
                                  if (activeSessionId) void confirmBranch({ sessionId: activeSessionId, tipId: row.id }, 'none')
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
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="start" className="max-w-md">
                              <span className="line-clamp-8 whitespace-pre-wrap wrap-anywhere">{row.text}</span>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem disabled={busy} onSelect={() => {
                        if (activeSessionId) void confirmBranch({ sessionId: activeSessionId, tipId: row.id }, 'none')
                      }}>
                        <CornerDownRight data-icon="inline-start" />
                        {t('tree.jump')}
                      </ContextMenuItem>
                      <ContextMenuItem disabled={busy} onSelect={() => {
                        if (activeSessionId) void confirmBranch({ sessionId: activeSessionId, tipId: row.id }, 'summary')
                      }}>
                        <ListCollapse data-icon="inline-start" />
                        {t('tree.summarizeJump')}
                      </ContextMenuItem>
                      <ContextMenuItem disabled={busy} onSelect={() => {
                        if (!activeSessionId) return
                        setInstructions('')
                        setCustomTarget({ sessionId: activeSessionId, tipId: row.id })
                      }}>
                        <MessageSquareText data-icon="inline-start" />
                        {t('tree.customSummary')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
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
        {branchError && <Alert variant="destructive"><AlertDescription className="text-xs">{branchError}</AlertDescription></Alert>}
        {busy && selection ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            <span className="flex-1">{t(summaryMode === 'none' ? 'tree.switching' : 'tree.summarizing')}</span>
            {summaryMode !== 'none' ? (
              <Button variant="outline" size="sm" disabled={stopping} onClick={() => {
                setStopping(true)
                void api.abortBranchSummary(selection.sessionId).catch((reason: unknown) => {
                  setBranchError(reason instanceof Error ? reason.message : String(reason))
                })
              }}>{t('tree.stopSummary')}</Button>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {visible.length}/{rows.length}
          </div>
        )}
        </div>
      </DialogContent>
      <AlertDialog open={!!customTarget} onOpenChange={(next) => { if (!next) setCustomTarget(null) }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('tree.customSummary')}</AlertDialogTitle>
            <AlertDialogDescription className="sr-only">{t('tree.customInstructions')}</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label={t('tree.customInstructions')}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t('tree.customPlaceholder')}
            className="min-h-20 text-xs md:text-xs"
            autoFocus
          />
          <AlertDialogFooter className="sm:justify-between">
            <Button variant="ghost" size="sm" onClick={() => setCustomTarget(null)}>
              <ChevronLeft data-icon="inline-start" />
              {t('tree.back')}
            </Button>
            <Button size="sm" disabled={busy || !instructions.trim()} onClick={() => {
              const target = customTarget
              if (!target) return
              setCustomTarget(null)
              void confirmBranch(target, 'custom', instructions.trim())
            }}>{t('tree.summarizeJump')}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
