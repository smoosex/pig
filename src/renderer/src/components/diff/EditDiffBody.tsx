import { useMemo } from 'react'
import { parseDiffFromFile } from '@pierre/diffs'
import { FileDiff, Virtualizer } from '@pierre/diffs/react'
import { useDarkMode } from '../../lib/useDarkMode'
import { fileDiffOptions } from './diff-options'

/**
 * The `edit` tool's old/new pair rendered as a real diff: jsdiff decides the hunks, so a change in the
 * middle of a long block shows the change plus a few lines of context instead of the whole block with
 * its middle marked deleted and re-added, and the lines come back syntax highlighted.
 *
 * Imported lazily by `ToolRow`, so the library and its Shiki renderer are only fetched when a step is
 * actually opened, and each block virtualizes its own rows.
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
    <div className="flex flex-col gap-2">
      {diffs.map((fileDiff, index) => (
        <div key={index} className="overflow-hidden rounded-lg border border-code-border">
          {diffs.length > 1 ? (
            <div className="border-b border-code-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
              {`// — edit ${index + 1} —`}
            </div>
          ) : null}
          <Virtualizer className="max-h-80 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <FileDiff fileDiff={fileDiff} options={options} />
          </Virtualizer>
        </div>
      ))}
    </div>
  )
}
