/** Renders shared Shiki code surfaces, with plain-text fallback until highlighting is visible and ready. */
import { useRef } from 'react'
import { useHighlightHtml } from '../lib/highlight'
import { cn, hideScroll } from '../lib/utils'

export const codeSurface = 'rounded-lg border border-code-border bg-code-background text-code-foreground'
export const bashCodeSurface = cn(codeSurface, 'bg-secondary')

const highlightedPre = '[&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:text-xs'
const numberedLines = '[&_code]:[counter-reset:line] [&_.line]:before:mr-3 [&_.line]:before:inline-block [&_.line]:before:w-7 [&_.line]:before:border-r [&_.line]:before:border-code-border [&_.line]:before:pr-2 [&_.line]:before:text-right [&_.line]:before:text-muted-foreground [&_.line]:before:content-[counter(line)] [&_.line]:before:[counter-increment:line]'

const commandLayout = {
  pre: '[&_pre]:px-3 [&_pre]:py-2 [&_pre]:break-words [&_pre]:whitespace-pre-wrap [&_pre]:leading-snug',
  fallback: 'whitespace-pre-wrap break-words px-3 py-2'
} as const

const variants = {
  fence: {
    viewport: `${codeSurface} my-2 max-h-80 leading-snug`,
    pre: '[&_pre]:p-3 [&_pre]:leading-snug',
    fallback: 'whitespace-pre p-3'
  },
  file: {
    viewport: 'max-h-80 leading-4',
    pre: '[&_pre]:p-3 [&_pre]:leading-4',
    fallback: 'whitespace-pre p-3'
  },
  command: {
    viewport: `${bashCodeSurface} max-h-60 leading-snug`,
    ...commandLayout
  },
  terminal: {
    viewport: `${codeSurface} max-h-60 leading-snug`,
    ...commandLayout
  }
} as const

export function HighlightedCode({
  code,
  lang,
  variant = 'fence',
  fileListing = false,
  notice
}: {
  code: string
  lang: string
  variant?: keyof typeof variants
  fileListing?: boolean
  notice?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useHighlightHtml(code, lang, ref)
  const numbered = variant === 'file' && fileListing

  return (
    <div
      ref={ref}
      className={cn('overflow-auto font-mono text-xs', hideScroll, variants[variant].viewport)}
    >
      {html ? (
        <div
          className={cn(highlightedPre, variants[variant].pre, numbered && numberedLines)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : numbered ? (
        <pre className="m-0 py-3 whitespace-pre">
          {code.split('\n').map((line, index) => (
            <span key={index} className="block min-w-max px-3">
              <span className="mr-3 inline-block w-7 select-none border-r border-code-border pr-2 text-right text-muted-foreground">
                {index + 1}
              </span>
              {line || '\u200b'}
            </span>
          ))}
        </pre>
      ) : (
        <pre className={cn('m-0', variants[variant].fallback)}>{code}</pre>
      )}
      {notice ? <div className="px-3 pb-3 text-muted-foreground">{notice}</div> : null}
    </div>
  )
}
