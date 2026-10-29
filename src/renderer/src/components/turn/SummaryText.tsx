/**
 * The scrolling body of an expanded compaction or branch summary. Summaries reach hundreds of
 * thousands of characters while the box shows a few hundred pixels, so Markdown pieces are mounted
 * as the reader nears the end instead of all at once. It mounts with the expanding content, so the
 * next open starts again from the first piece.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { splitMarkdown } from '../../lib/markdown-chunks'
import { cn, hideScroll } from '../../lib/utils'
import { MarkdownText } from '../MarkdownText'

/** Parses and lays out in a frame or two. */
const CHUNK_CHARS = 16_000

export function SummaryText({ text }: { text: string }) {
  const chunks = useMemo(() => splitMarkdown(text, CHUNK_CHARS), [text])
  const [count, setCount] = useState(1)
  const scroller = useRef<HTMLDivElement>(null)
  const fillMore = () => {
    const node = scroller.current
    if (!node || count >= chunks.length) return
    if (node.scrollHeight - node.scrollTop - node.clientHeight < node.clientHeight * 2) setCount((n) => n + 1)
  }
  // A short first piece may not fill the box, leaving no scroll to ask for the next one.
  useEffect(fillMore)
  return (
    <div ref={scroller} onScroll={fillMore} className={cn('mt-2 flex max-h-80 flex-col gap-2 overflow-auto', hideScroll)}>
      {chunks.slice(0, count).map((chunk, index) => (
        <MarkdownText key={index} className="text-xs text-muted-foreground" text={chunk} />
      ))}
    </div>
  )
}
