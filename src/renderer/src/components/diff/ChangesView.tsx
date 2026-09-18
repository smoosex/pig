/**
 * The changes tab: one scope of the worktree in one scroll region, each file a collapsible section,
 * all of them fed by a single patch read. The scope is the tab's, chosen from the review column or the
 * toolbar's control — the toolbar label and the tab title are the same two words. The review column
 * points here — clicking one of its rows activates this tab, switches it to the row's group and asks it
 * to reveal that file, which is what `focus` carries.
 *
 * Bodies mount only near the viewport and very long ones scroll inside their own region, so opening a
 * worktree with hundreds of changed files does not render hundreds of diffs at once.
 *
 * Which files are folded and which one is being read both live in the store, per worktree: folding is
 * the reader's decision and survives switching tabs, and the reading position is what the review
 * column highlights.
 *
 * A reveal asked for by the review column is one-shot: the request is taken off the store once it has
 * been honoured, so folding the revealed file by hand and leaving the tab keeps it folded on the way
 * back.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronsDownUp, Columns2, Rows3 } from 'lucide-react'
import type { DiffFileEntry, DiffScope } from '../../ipc/api'
import {
  SCOPE_LABELS,
  patchKey,
  rememberScrollTop,
  savedScrollTop,
  retainWorktreePatch,
  retainWorktreeWatch,
  useDiffStore
} from '../../stores/diff'
import { useSessionsStore } from '../../stores/sessions'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { cn } from '../../lib/utils'
import { STATUS_META, fileIcon, splitPath } from './file-entry'
import {
  SECTION_SCROLL_LINES,
  buildSections,
  materializeSection,
  scopeEntries,
  sectionId,
  type DiffSection,
  type SectionNote
} from './sections'

const DiffBody = lazy(() => import('./DiffBody'))

/** The three scopes in the order the toolbar offers them. */
const SCOPES: DiffScope[] = ['all', 'staged', 'unstaged']

/** Shared empty map, so a worktree with nothing folded does not hand zustand a new object per render. */
const NOTHING_EXPANDED: Record<string, boolean> = {}
const NOTHING_UNTRACKED: Record<string, never> = {}

/** How long a reveal keeps re-aligning its file after the last change of the canvas height. */
const REVEAL_SETTLE_MS = 700
const REVEAL_DEADLINE_MS = 2_000
const REVEAL_MAX_FRAMES = 120

export function ChangesView({ cwd }: { cwd: string }) {
  const diffState = useDiffStore((s) => s.worktrees[cwd])
  const scope =
    useSessionsStore(
      (s) => s.openTabs.find((tab) => tab.kind === 'diff' && tab.cwd === cwd)?.diffScope
    ) ?? 'all'
  const setScope = useSessionsStore((s) => s.setChangesScope)
  const scopeKey = patchKey(cwd, scope)
  const patchState = useDiffStore((s) => s.patches[scopeKey])
  const paths = useRef<string[]>([])
  const diffStyle = useDiffStore((s) => s.diffStyle)
  const setDiffStyle = useDiffStore((s) => s.setDiffStyle)
  const focus = useDiffStore((s) => s.focus)
  const clearFocus = useDiffStore((s) => s.clearFocus)
  const expanded = useDiffStore((s) => s.expanded[cwd]) ?? NOTHING_EXPANDED
  const setExpanded = useDiffStore((s) => s.setExpanded)
  const untracked = useDiffStore((s) => s.untracked[cwd]) ?? NOTHING_UNTRACKED
  const loadUntrackedFile = useDiffStore((s) => s.loadUntrackedFile)
  const setVisiblePath = useDiffStore((s) => s.setVisiblePath)
  const list = useRef<HTMLDivElement | null>(null)
  /** A reveal from the review column has already placed this canvas, so no restore may fight it. */
  const revealed = useRef(false)
  /** The file a reveal still has to bring to the top of the canvas, until the layout stops moving. */
  const pendingReveal = useRef<{
    path: string
    height: number
    until: number
    deadline: number
    frames: number
  } | null>(null)
  const revealFrame = useRef(0)

  function stopReveal(): void {
    pendingReveal.current = null
    if (revealFrame.current) cancelAnimationFrame(revealFrame.current)
    revealFrame.current = 0
  }

  const diff = diffState?.diff
  const entries = scopeEntries(diff, scope)
  const sections = useMemo(
    () => buildSections(diff, patchState?.patch, scope, untracked),
    [diff, patchState?.patch, scope, untracked]
  )
  const ready = patchState?.status === 'ready'
  const pending = patchState?.status === 'loading' && !patchState.patch

  useEffect(() => retainWorktreeWatch(cwd), [cwd])
  useEffect(() => retainWorktreePatch(cwd, scope), [cwd, scope])

  useEffect(() => {
    revealed.current = false
    stopReveal()
  }, [scopeKey])

  // Read through a ref so a refresh of the patch cannot replay the reveal and yank the scroll position.
  useEffect(() => {
    paths.current = sections.map((section) => section.entry.path)
    const pending = pendingReveal.current
    if (pending && !paths.current.includes(pending.path)) stopReveal()
  }, [sections])

  /**
   * Puts a revealed card's header at the top of the canvas. Folding the other files unmounts their
   * bodies while the target's own body mounts a moment later, so the alignment keeps correcting until
   * the canvas stops changing height; a card near the end can be too short to ever reach the top, and
   * the canvas cannot scroll past its own end.
   */
  function alignReveal(): void {
    const pending = pendingReveal.current
    if (!pending) return
    if (performance.now() > pending.deadline || !paths.current.includes(pending.path)) {
      stopReveal()
      return
    }
    const region = list.current
    const element = document.getElementById(sectionId(pending.path))
    if (!region || !element) return
    const delta = element.getBoundingClientRect().top - region.getBoundingClientRect().top
    if (Math.abs(delta) > 1) region.scrollTop += delta
    const now = performance.now()
    if (region.scrollHeight !== pending.height) {
      pending.height = region.scrollHeight
      pending.until = now + REVEAL_SETTLE_MS
      return
    }
    if (now > pending.until) pendingReveal.current = null
  }

  /** Rides the frames while a reveal is pending: a diff body grows its card without a commit of ours. */
  function pumpReveal(): void {
    if (revealFrame.current) return
    const tick = () => {
      const pending = pendingReveal.current
      if (pending && ++pending.frames > REVEAL_MAX_FRAMES) stopReveal()
      else alignReveal()
      revealFrame.current = pendingReveal.current ? requestAnimationFrame(tick) : 0
    }
    revealFrame.current = requestAnimationFrame(tick)
  }

  // Frames are throttled in a background window, so a pending reveal must not outlive the mount.
  useEffect(() => () => stopReveal(), [])

  // A panel row asks for one file: open it alone, bring it into view, then drop the request — asking
  // is an action, not a mode, otherwise coming back to the tab would undo the reader's own folds.
  useEffect(() => {
    if (!focus || focus.cwd !== cwd || !ready) return
    const path = focus.path
    revealed.current = true
    clearFocus(cwd)
    setExpanded(cwd, { [path]: true })
    const now = performance.now()
    pendingReveal.current = {
      path,
      height: 0,
      until: now + REVEAL_SETTLE_MS,
      deadline: now + REVEAL_DEADLINE_MS,
      frames: 0
    }
    alignReveal()
    pumpReveal()
  }, [focus, cwd, ready, clearFocus, setExpanded])

  // Diff bodies mount lazily, so the region is still short when this starts: keep asking until it can
  // hold the offset. A reveal asked for from the review column has the say instead.
  useEffect(() => {
    const target = savedScrollTop(scopeKey)
    if (!ready || !target || revealed.current) return
    let frame = 0
    let tries = 0
    const restore = () => {
      const region = list.current
      if (!region) return
      region.scrollTop = target
      if (region.scrollTop < target && tries++ < 60) frame = requestAnimationFrame(restore)
    }
    // The first attempt is immediate: a backgrounded window gets no animation frames, and coming
    // back to it should already be in the right place.
    restore()
    return () => cancelAnimationFrame(frame)
  }, [ready, focus, cwd, scopeKey])

  // Follow the reading: the review column marks the card that holds the middle of the viewport, so a
  // long card is marked while it is being read instead of only while it touches the top edge.
  const measureNow = useRef<() => void>(() => {})
  useEffect(() => {
    // Nothing measured while the tab is not rendering cards, so a stale closure cannot mark a file
    // in a worktree that is no longer on screen.
    measureNow.current = () => {}
    if (!ready) return
    const region = list.current
    if (!region) return
    let frame = 0
    const run = () => {
      const order = paths.current
      if (!order.length) return
      // A canvas that fits on screen keeps its first card marked, and at the very bottom the last card
      // can be too short to ever reach the middle of the region.
      const scrollable = region.scrollHeight > region.clientHeight + 4
      const atEnd = region.scrollTop + region.clientHeight >= region.scrollHeight - 4
      if (!scrollable) {
        setVisiblePath(cwd, order[0])
        return
      }
      if (atEnd) {
        setVisiblePath(cwd, order[order.length - 1])
        return
      }
      const middle = region.getBoundingClientRect().top + region.clientHeight / 2
      let current = order[0]
      let closest = Number.POSITIVE_INFINITY
      for (const path of order) {
        const element = document.getElementById(sectionId(path))
        if (!element) continue
        const rect = element.getBoundingClientRect()
        if (rect.top <= middle && rect.bottom >= middle) {
          current = path
          break
        }
        const distance = Math.min(Math.abs(rect.top - middle), Math.abs(rect.bottom - middle))
        if (distance < closest) {
          closest = distance
          current = path
        }
      }
      setVisiblePath(cwd, current)
    }
    const measure = () => {
      frame = 0
      run()
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measureNow.current = run
    // The position is recorded on the event, not in the frame callback: frames are throttled when the
    // window is in the background, and the reading position should not be lost to that.
    const onScroll = () => {
      rememberScrollTop(scopeKey, region.scrollTop)
      schedule()
    }
    // The reader has the last word: touching the canvas ends a reveal that is still settling.
    const takenOver = () => stopReveal()
    measure()
    region.addEventListener('scroll', onScroll, { passive: true })
    region.addEventListener('wheel', takenOver, { passive: true })
    region.addEventListener('pointerdown', takenOver)
    region.addEventListener('touchstart', takenOver, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      region.removeEventListener('scroll', onScroll)
      region.removeEventListener('wheel', takenOver)
      region.removeEventListener('pointerdown', takenOver)
      region.removeEventListener('touchstart', takenOver)
      window.removeEventListener('resize', schedule)
    }
  }, [ready, cwd, scopeKey, sections, setVisiblePath])

  // A fold, a lazily mounted diff body and a font landing all move the cards after the commit that
  // caused them, so a pending reveal is re-aligned and the marked card re-measured on every render —
  // synchronously, because a background window gets no frames.
  useEffect(() => {
    alignReveal()
    measureNow.current()
  })

  const allExpanded = sections.length > 0 && sections.every((section) => expanded[section.entry.path])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={allExpanded ? '折叠全部' : '展开全部'}
          disabled={!sections.length}
          onClick={() =>
            setExpanded(cwd, allExpanded ? {} : Object.fromEntries(sections.map((s) => [s.entry.path, true])))
          }
        >
          <ChevronsDownUp className={cn(allExpanded && 'rotate-180')} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="gap-0.5 px-1 text-xs font-medium"
              aria-label="变更范围"
            >
              <ChevronDown className="size-3 text-muted-foreground" />
              {SCOPE_LABELS[scope]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={scope} onValueChange={(value) => setScope(cwd, value as DiffScope)}>
              {SCOPES.map((value) => (
                <DropdownMenuRadioItem key={value} value={value} className="text-xs">
                  {SCOPE_LABELS[value]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-xs tabular-nums text-muted-foreground">{entries.length} 个更改</span>
        <span className="flex-1" />
        <ToggleGroup
          type="single"
          spacing={0.5}
          size="xs"
          className="border p-px"
          value={diffStyle}
          onValueChange={(value) => value && setDiffStyle(value as 'unified' | 'split')}
          aria-label="diff 布局"
        >
          <ToggleGroupItem value="unified" aria-label="统一视图">
            <Rows3 />
          </ToggleGroupItem>
          <ToggleGroupItem value="split" aria-label="并排视图">
            <Columns2 />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Same surface as the conversation, so the diff reads as part of the chat rather than a panel. */}
      <div
        ref={list}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-chat-background p-3',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        {renderList()}
      </div>
    </div>
  )

  function renderList() {
    if (!diffState) return <Notice flush>正在读取变更…</Notice>
    if (diffState.watchError) return <Notice flush>{diffState.watchError}</Notice>
    if (pending && !diffState.diff) return <Notice flush>正在读取变更…</Notice>
    if (diffState.status === 'error') return <Notice flush>{diffState.error}</Notice>
    if (patchState?.status === 'error') return <Notice flush>{patchState.error}</Notice>
    if (!diff?.git) return <Notice flush>当前目录不是 Git 仓库</Notice>
    if (!sections.length) return <Notice flush>{emptyText(scope)}</Notice>
    return (
      <>
        {patchState?.patch?.truncated ? <Notice flush>变更过大，超出的文件未读取</Notice> : null}
        {sections.map((section) => {
          const entry = section.entry
          const meta = STATUS_META[entry.status]
          const Icon = fileIcon(entry.path)
          const { name, directory } = splitPath(entry.path)
          const open = expanded[entry.path] === true
          const lines = (entry.additions ?? 0) + (entry.deletions ?? 0)
          return (
            <section
              key={`${scopeKey}\u0000${entry.path}`}
              id={sectionId(entry.path)}
              className="shrink-0 overflow-hidden rounded-lg border border-border bg-popover shadow-sm"
            >
              <button
                type="button"
                title={entry.path}
                aria-expanded={open}
                onClick={() => setExpanded(cwd, { ...expanded, [entry.path]: !open })}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-accent/60"
              >
                <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
                <span className={cn('w-2.5 shrink-0 font-medium', meta.className)} aria-label={meta.label}>
                  {meta.letter}
                </span>
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 truncate font-medium">{name}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="rtl">
                  {directory}
                </span>
                {entry.additions === null ? null : (
                  <span className="shrink-0 tabular-nums text-success">+{entry.additions}</span>
                )}
                {entry.deletions === null ? null : (
                  <span className="shrink-0 tabular-nums text-destructive">-{entry.deletions}</span>
                )}
              </button>
              {open ? (
                <div className="border-t border-border">
                  <SectionBody
                    cwd={cwd}
                    section={section}
                    load={loadUntrackedFile}
                    scroll={lines > SECTION_SCROLL_LINES}
                  />
                </div>
              ) : null}
            </section>
          )
        })}
      </>
    )
  }
}

/**
 * A diff body is the expensive part of the tab, so it waits until it is scrolled near and, when it is
 * long, gets its own scroll region instead of stretching the page. An untracked file has to be read
 * from main first, which is what `pending` says, and the body keeps drawing the diff it already had
 * while that read is on its way.
 */
function SectionBody({
  cwd,
  section,
  load,
  scroll
}: {
  cwd: string
  section: DiffSection
  load: (cwd: string, path: string) => Promise<void>
  scroll: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const diffStyle = useDiffStore((s) => s.diffStyle)
  const [near, setNear] = useState(false)
  const resolved = useMemo(() => near ? materializeSection(section) : section, [near, section])
  const { entry, fileDiff, note, bytes, message, pending } = resolved
  const preparing = !near && section.source !== undefined
  const shown = useRef<DiffSection['fileDiff']>(null)
  if (fileDiff) shown.current = fileDiff

  useEffect(() => {
    const node = ref.current
    if (!node || near) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) setNear(true)
      },
      { rootMargin: '800px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [near])

  useEffect(() => {
    if (near && pending && entry.status === 'untracked') void load(cwd, entry.path)
  }, [near, pending, cwd, entry.path, entry.status, load])

  // A note is why this file has nothing to draw, so it wins over a diff that is only still here from an
  // earlier read of the same card.
  const drawing = note ? null : (fileDiff ?? shown.current)
  // No padding of its own: the diff draws its own line grid edge to edge.
  return (
    <div ref={ref} className="text-xs">
      {drawing ? (
        near ? (
          <Suspense fallback={<Notice>正在渲染…</Notice>}>
            <DiffBody fileDiff={drawing} style={diffStyle} scroll={scroll} />
          </Suspense>
        ) : (
          <Notice>正在准备…</Notice>
        )
      ) : pending || preparing ? (
        <Notice>{near && pending && entry.status === 'untracked' ? '正在读取…' : '正在准备…'}</Notice>
      ) : (
        <Notice>{noteText(note, entry, bytes, message)}</Notice>
      )}
    </div>
  )
}

function noteText(note: SectionNote, entry: DiffFileEntry, bytes?: number, message?: string): string {
  switch (note) {
    case 'binary':
      return '二进制文件，无法显示文本差异'
    case 'too-large':
      return bytes ? `文件过大（${Math.round(bytes / 1024 / 1024)} MB），未读取` : '文件过大，未读取'
    case 'changed':
      return '读取时文件已换成链接，未读取'
    case 'failed':
      return message ? `读取失败：${message}` : '读取失败'
    case 'truncated':
      return '变更过大，未读取此文件'
    case 'unparsed':
      return message ? `无法解析此文件的变更：${message}` : '无法解析此文件的变更'
    default:
      return entry.status === 'deleted' ? '文件已删除' : '没有可显示的变更'
  }
}

/** What an empty canvas means depends on what it was asked for. */
function emptyText(scope: DiffScope): string {
  if (scope === 'staged') return '暂存区没有变更'
  if (scope === 'unstaged') return '工作区没有未提交的变更'
  return '工作区没有未提交的变更'
}

/** `flush` is for notices that sit in the padded list itself rather than inside a file card. */
function Notice({ children, flush }: { children: React.ReactNode; flush?: boolean }) {
  return <div className={cn('py-2 text-xs text-muted-foreground', flush ? 'px-1' : 'px-3')}>{children}</div>
}
