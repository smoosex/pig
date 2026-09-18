import { useMemo } from 'react'
import { FileDiff, Virtualizer, type FileDiffMetadata } from '@pierre/diffs/react'
import { useDarkMode } from '../../lib/useDarkMode'
import type { DiffStyle } from '../../stores/diff'
import { fileDiffOptions } from './diff-options'

/**
 * Loaded only once a diff is on screen: `@pierre/diffs` pulls the Shiki renderer along with it, and
 * sessions that never open a change should not pay for it.
 *
 * `preferredHighlighter` is asked for on purpose: the shared highlighter takes its engine from
 * whichever call creates it first, and the WASM engine is several times faster than the JS one.
 */
export default function DiffBody({
  fileDiff,
  style,
  scroll
}: {
  fileDiff: FileDiffMetadata
  style: DiffStyle
  /** A long diff scrolls inside its own region instead of stretching the changes list. */
  scroll: boolean
}) {
  const dark = useDarkMode()
  const options = useMemo(() => fileDiffOptions(dark, style), [dark, style])

  if (!scroll) return <FileDiff fileDiff={fileDiff} options={options} />
  return (
    <Virtualizer className="max-h-[70vh] overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <FileDiff fileDiff={fileDiff} options={options} />
    </Virtualizer>
  )
}
