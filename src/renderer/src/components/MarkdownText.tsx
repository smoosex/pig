import type { Components } from 'react-markdown'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useHighlightHtml } from '../lib/highlight'
import { cn } from '../lib/utils'
import { Separator } from './ui/separator'

function CodeFence({ lang, code }: { lang: string; code: string }) {
  const html = useHighlightHtml(code, lang || 'plaintext')
  return (
    <div className="my-2 max-h-80 overflow-auto rounded-lg border border-border bg-card font-mono text-xs leading-snug [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

const components: Components = {
  p: ({ children }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a href={href} className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">
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
    if (!lang && !text.includes('\n')) {
      return <code className="rounded-sm bg-muted px-1 py-px font-mono text-xs">{children}</code>
    }
    return <CodeFence lang={lang ?? 'plaintext'} code={text} />
  }
}

export function MarkdownText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
