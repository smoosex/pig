import { useMemo } from 'react'
import { parseDiffFromFile } from '@pierre/diffs'
import { FileDiff, Virtualizer } from '@pierre/diffs/react'
import { useDarkMode } from '../../lib/useDarkMode'
import { cn } from '../../lib/utils'
import { glassCodeSurface } from '../HighlightedCode'
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
  edits
}: {
  path: string
  edits: { oldText: string; newText: string }[]
}) {
  const dark = useDarkMode()
  const options = useMemo(() => fileDiffOptions(dark, 'unified'), [dark])
  const diffs = useMemo(
    () =>
      edits.map((edit) =>
        parseDiffFromFile({ name: path, contents: edit.oldText }, { name: path, contents: edit.newText })
      ),
    [edits, path]
  )
  return (
    <div className={cn('glass-code-surface overflow-hidden [--diffs-gap-block:0px]', glassCodeSurface)}>
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
