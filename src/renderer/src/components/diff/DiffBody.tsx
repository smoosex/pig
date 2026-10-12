import { useCallback, useMemo, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { FileDiff, Virtualizer, type FileDiffMetadata, type FileDiffOptions } from '@pierre/diffs/react'
import { useDarkMode } from '../../lib/useDarkMode'
import { useT } from '../../hooks/useT'
import { useSessionsStore } from '../../stores/sessions'
import { useFilesStore } from '../../stores/files'
import { Button } from '../ui/button'
import type { DiffStyle } from '../../stores/diff'
import { fileDiffOptions } from './diff-options'

/**
 * Loaded only once a diff is on screen: `@pierre/diffs` pulls the Shiki renderer along with it, and
 * sessions that never open a change should not pay for it.
 *
 * `preferredHighlighter` is asked for on purpose: the shared highlighter takes its engine from
 * whichever call creates it first, and the WASM engine is several times faster than the JS one.
 *
 * Every card here can be followed into the file it came from: the library's gutter utility marks the
 * hovered row, and following one asks for the file tab and the line the row stands for. Only the
 * additions side is followed — a deletion's number belongs to the file as it was, which a tab cannot
 * show — so the affordance is dropped rather than pointed at a line that is not there.
 */
export default function DiffBody({
  cwd,
  path,
  fileDiff,
  style,
  scroll
}: {
  cwd: string
  path: string
  fileDiff: FileDiffMetadata
  style: DiffStyle
  /** A long diff scrolls inside its own region instead of stretching the changes list. */
  scroll: boolean
}) {
  const dark = useDarkMode()
  const follow = useLineFollow(cwd, path)
  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({ ...fileDiffOptions(dark, style), ...follow.options }),
    [dark, style, follow.options]
  )
  const utility = follow.renderGutterUtility

  if (!scroll) return <FileDiff fileDiff={fileDiff} options={options} renderGutterUtility={utility} />
  return (
    <Virtualizer className="max-h-[70vh] overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <FileDiff fileDiff={fileDiff} options={options} renderGutterUtility={utility} />
    </Virtualizer>
  )
}

/** The row the pointer is on, as the library's own hovered-line getter spells it. */
interface HoveredLine {
  lineNumber: number
  side: 'deletions' | 'additions'
}

/**
 * Keeps whether the pointer is on a row, so the utility can decide whether there is anything to follow,
 * and hands the follow itself over to the tabs and the file store.
 *
 * The row itself is read back off the interaction manager when the affordance is drawn, because that is
 * the one the library moves the utility slot onto: a callback's argument is the row the pointer entered,
 * which is one pointer move behind the row being drawn. So the callbacks only say whether there is a row
 * at all, and the getter is the only thing that names the line the affordance points at.
 */
function useLineFollow(cwd: string, path: string) {
  const t = useT()
  const openFileTab = useSessionsStore((state) => state.openFileTab)
  const revealLine = useFilesStore((state) => state.revealLine)
  const [hovered, setHovered] = useState(false)

  const options = useMemo<Pick<FileDiffOptions<undefined, undefined>, 'enableGutterUtility' | 'onLineEnter' | 'onLineLeave'>>(
    () => ({
      enableGutterUtility: true,
      onLineEnter: () => setHovered(true),
      onLineLeave: () => setHovered(false)
    }),
    []
  )

  const renderGutterUtility = useCallback(
    (getHoveredLine: () => HoveredLine | undefined) => {
      const row = getHoveredLine()
      if (!hovered || !row || row.side !== 'additions') return null
      const label = t('diff.followLine', { line: row.lineNumber })
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          title={label}
          // The slot is a light-DOM node the shadow tree stretches over the row's number cell, so it is
          // placed with the app's own spacing and colors rather than the library's built-in button.
          className="size-4 rounded-sm bg-code-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => {
            void openFileTab(cwd, path)
            revealLine(cwd, path, row.lineNumber)
          }}
        >
          <ArrowUpRight className="size-3" aria-hidden />
        </Button>
      )
    },
    [cwd, path, hovered, openFileTab, revealLine, t]
  )

  return { options, renderGutterUtility }
}
