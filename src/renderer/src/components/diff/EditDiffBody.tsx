import { useEffect, useMemo, useRef } from 'react'
import { parseDiffFromFile } from '@pierre/diffs'
import { FileDiff, Virtualizer } from '@pierre/diffs/react'
import { useDarkMode } from '../../lib/useDarkMode'
import { cn } from '../../lib/utils'
import { glassCodeSurface } from '../HighlightedCode'
import { FOLLOW_SCROLL_THRESHOLD_PX } from '../turn/useFollowScroll'
import { fileDiffOptions } from './diff-options'

/**
 * The `edit` tool's old/new pair rendered as a real diff: jsdiff decides the hunks, so a change in the
 * middle of a long block shows the change plus a few lines of context instead of the whole block with
 * its middle marked deleted and re-added, and the lines come back syntax highlighted.
 *
 * Imported lazily by `ToolRow`, so the library and its Shiki renderer are only fetched when a step is
 * actually opened. Every edit sits in one scroll panel so a multi-edit step reads as a single diff
 * window instead of a stack of bordered blocks.
 */
export default function EditDiffBody({
  path,
  edits,
  follow = false
}: {
  path: string
  edits: { oldText: string; newText: string }[]
  follow?: boolean
}) {
  const dark = useDarkMode()
  const hostRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const prevFollow = useRef(false)
  if (follow && !prevFollow.current) {
    following.current = true
  }
  prevFollow.current = follow

  const options = useMemo(() => fileDiffOptions(dark, 'unified'), [dark])
  const diffs = useMemo(
    () =>
      edits.map((edit) =>
        parseDiffFromFile({ name: path, contents: edit.oldText }, { name: path, contents: edit.newText })
      ),
    [edits, path]
  )

  useEffect(() => {
    if (!follow || !following.current) return
    const scroller = hostRef.current?.firstElementChild as HTMLElement | null
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [follow, diffs])

  return (
    <div
      ref={hostRef}
      onScrollCapture={(event) => {
        const scroller = hostRef.current?.firstElementChild
        if (scroller && event.target === scroller) {
          const el = scroller as HTMLElement
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SCROLL_THRESHOLD_PX
        }
      }}
      className={cn('glass-code-surface overflow-hidden [--diffs-gap-block:0px]', glassCodeSurface)}
    >
      <Virtualizer className="max-h-80 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {diffs.map((fileDiff, index) => (
          <div key={index}>
            {diffs.length > 1 ? (
              <div className={`${index > 0 ? 'border-t ' : ''}border-b border-glass-card-border px-3 py-1.5 solid:border-code-border font-mono text-xs text-muted-foreground`}>
                {`// — edit ${index + 1} —`}
              </div>
            ) : null}
            <FileDiff fileDiff={fileDiff} options={options} />
          </div>
        ))}
      </Virtualizer>
    </div>
  )
}
