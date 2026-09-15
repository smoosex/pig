import { memo, useEffect, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Streamdown, preprocessLaTeX } from '@lobehub/streamdown'
import { useHighlightHtml } from '../lib/highlight'
import { renderMermaid } from '../lib/mermaid-renderer'
import { useDarkMode } from '../lib/useDarkMode'
import { cn } from '../lib/utils'
import { Separator } from './ui/separator'
import 'katex/dist/katex.min.css'

const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [rehypeKatex]

function CodeFence({ lang, code }: { lang: string; code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useHighlightHtml(code, lang || 'plaintext', ref)
  return (
    <div
      ref={ref}
      className="my-2 max-h-80 overflow-auto rounded-lg border border-code-border bg-code-background font-mono text-code-foreground text-xs leading-snug [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {html ? (
        <div
          className="[&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-snug"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 whitespace-pre p-3">{code}</pre>
      )}
    </div>
  )
}

function MermaidBlock({ code }: { code: string }) {
  const dark = useDarkMode()
  const [result, setResult] = useState<{ code: string; dark: boolean; svg: string | null }>()

  useEffect(() => {
    const controller = new AbortController()
    void renderMermaid(code, dark, controller.signal).then(
      (svg) => { if (!controller.signal.aborted) setResult({ code, dark, svg }) },
      () => { if (!controller.signal.aborted) setResult({ code, dark, svg: null }) }
    )
    return () => controller.abort()
  }, [code, dark])

  if (result?.code !== code || result.dark !== dark || !result.svg) return <CodeFence lang="plaintext" code={code} />
  return (
    <div
      className="my-2 max-w-full overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  )
}

const components: Components = {
  p: ({ children }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a href={href} className="text-link underline underline-offset-2" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mb-2 flex list-disc flex-col gap-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 flex list-decimal flex-col gap-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="mt-3 mb-2 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-2 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">{children}</blockquote>
  ),
  hr: () => <Separator className="my-3" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-auto last:mb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border bg-muted/50 px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-([\w-]+)/.exec(className ?? '')?.[1]
    const text = String(children).replace(/\n$/, '')
    if (lang === 'mermaid') return <MermaidBlock code={text} />
    if (!lang && !text.includes('\n')) {
      return <code className="rounded-sm bg-inline-code-background px-1 py-px font-mono text-xs text-code-foreground">{children}</code>
    }
    return <CodeFence lang={lang ?? 'plaintext'} code={text} />
  }
}

export const MarkdownText = memo(function MarkdownText({
  text,
  className,
  streaming = false
}: {
  text: string
  className?: string
  streaming?: boolean
}) {
  return (
    <div className={cn('min-w-0 [&_.katex]:text-foreground', className)}>
      {streaming ? (
        <Streamdown
          content={text}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          granularity="char"
          smoothing="balanced"
          latexGuard
          preprocess={preprocessLaTeX}
        />
      ) : (
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {text}
        </Markdown>
      )}
    </div>
  )
})
