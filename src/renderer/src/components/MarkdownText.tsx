import { memo, useEffect, useMemo, useState } from 'react'
import type { Components, Options } from 'react-markdown'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Element } from 'hast'
import { Streamdown, preprocessLaTeX } from '@lobehub/streamdown'
import { renderMermaid } from '../lib/mermaid-renderer'
import { useDarkMode } from '../lib/useDarkMode'
import { cn } from '../lib/utils'
import { HighlightedCode } from './HighlightedCode'
import { Separator } from './ui/separator'
import 'katex/dist/katex.min.css'

const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [rehypeKatex]

/**
 * Raw HTML is only for files a person wrote, such as a README laid out with `<p align>`, `<img>` and
 * `<details>`. GitHub's allowlist drops scripts, event handlers, styles and embeds; the math classes are
 * added because the sanitizer runs before KaTeX looks for them. Inline images are allowed as `data:`
 * sources, which `fileUrlTransform` narrows to image types on `<img>` alone.
 */
const htmlSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), 'data'] },
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']]
  }
}
const htmlRehypePlugins: Options['rehypePlugins'] = [rehypeRaw, [rehypeSanitize, htmlSchema], rehypeKatex]

/** The sanitizer prefixes ids itself, so footnotes must not arrive already prefixed by remark. */
const htmlRemarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: '' }

const fileUrlTransform: Options['urlTransform'] = (url, key, node) =>
  node.tagName === 'img' && key === 'src' && /^data:image\//i.test(url) ? url : defaultUrlTransform(url)

/** `align` on block HTML, the way READMEs center a logo or a title. */
function alignClass(node: Element | undefined): string | undefined {
  const align = node?.properties.align
  return align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : undefined
}

function CodeFence({ lang, code }: { lang: string; code: string }) {
  return <HighlightedCode code={code} lang={lang || 'plaintext'} variant="markdown" />
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
  p: ({ node, children }) => <p className={cn('mb-2 whitespace-pre-wrap last:mb-0', alignClass(node))}>{children}</p>,
  div: ({ node, children }) => <div className={alignClass(node)}>{children}</div>,
  a: ({ id, href, children }) => (
    <a id={id} href={href} className="text-link underline underline-offset-2" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mb-2 flex list-disc flex-col gap-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 flex list-decimal flex-col gap-1 pl-5 last:mb-0">{children}</ol>,
  // Footnote references and their back-links are anchors, so their ids have to reach the DOM.
  li: ({ id, children }) => <li id={id} className="leading-relaxed">{children}</li>,
  h1: ({ node, children }) => <h1 className={cn('mt-3 mb-2 text-base font-semibold first:mt-0', alignClass(node))}>{children}</h1>,
  h2: ({ node, children }) => <h2 className={cn('mt-3 mb-2 text-sm font-semibold first:mt-0', alignClass(node))}>{children}</h2>,
  h3: ({ node, children }) => <h3 className={cn('mt-2.5 mb-1.5 text-sm font-semibold first:mt-0', alignClass(node))}>{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-glass-border pl-3 text-muted-foreground last:mb-0 solid:border-border">{children}</blockquote>
  ),
  hr: () => <Separator className="my-3" />,
  // In glass the frame is a raised card and the table hides its own outer cell borders; the edge overlay sits
  // outside the scroller so it stays put while wide tables scroll horizontally.
  table: ({ children }) => (
    <div className="relative mb-2 overflow-hidden rounded-lg bg-glass-composer-background/60 shadow-glass-card ring-1 ring-glass-card-border after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-glass-card-edge last:mb-0 solid:overflow-visible solid:rounded-none solid:bg-transparent solid:shadow-none solid:ring-0 solid:after:shadow-none">
      <div className="overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <table className="w-full border-collapse border-hidden text-sm solid:border-none">{children}</table>
      </div>
    </div>
  ),
  th: ({ children }) => <th className="border border-glass-border bg-glass-composer-background/60 px-2 py-1 text-left font-medium solid:border-border solid:bg-muted/50">{children}</th>,
  td: ({ children }) => <td className="border border-glass-border px-2 py-1 solid:border-border">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-([\w-]+)/.exec(className ?? '')?.[1]
    const text = String(children).replace(/\n$/, '')
    if (lang === 'mermaid') return <MermaidBlock code={text} />
    if (!lang && !text.includes('\n')) {
      return <code className="rounded-sm bg-foreground/8 px-1 py-px font-mono text-xs text-code-foreground shadow-glass-inline-code box-decoration-clone solid:bg-inline-code-background solid:shadow-none">{children}</code>
    }
    return <CodeFence lang={lang ?? 'plaintext'} code={text} />
  }
}

export const MarkdownText = memo(function MarkdownText({
  text,
  className,
  streaming = false,
  allowHtml = false,
  overrides
}: {
  text: string
  className?: string
  streaming?: boolean
  /** Render sanitized raw HTML instead of showing it as text. Never for model output. */
  allowHtml?: boolean
  /** Element renderers that replace the defaults; pass a stable object, the renderer is memoized. */
  overrides?: Components
}) {
  const merged = useMemo(() => (overrides ? { ...components, ...overrides } : components), [overrides])
  return (
    <div className={cn('min-w-0 [&_.katex]:text-foreground', className)}>
      {streaming ? (
        <Streamdown
          content={text}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={merged}
          granularity="char"
          smoothing="balanced"
          latexGuard
          preprocess={preprocessLaTeX}
        />
      ) : (
        <Markdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={allowHtml ? htmlRehypePlugins : rehypePlugins}
          urlTransform={allowHtml ? fileUrlTransform : defaultUrlTransform}
          remarkRehypeOptions={allowHtml ? htmlRemarkRehypeOptions : undefined}
          components={merged}
        >
          {text}
        </Markdown>
      )}
    </div>
  )
})
