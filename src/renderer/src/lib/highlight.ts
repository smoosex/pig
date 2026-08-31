import { useEffect, useState } from 'react'
import {
  createHighlighter,
  createJavaScriptRegexEngine,
  type BundledLanguage,
  type Highlighter
} from 'shiki'

const engine = createJavaScriptRegexEngine({ forgiving: true })

let ready: Promise<Highlighter> | undefined

function highlighter(): Promise<Highlighter> {
  ready ??= createHighlighter({
    engine,
    themes: ['github-dark'],
    langs: ['plaintext', 'typescript', 'tsx', 'javascript', 'jsx', 'json']
  })
  return ready
}

const EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  mdx: 'mdx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  ini: 'ini',
  env: 'ini',
  diff: 'diff'
}

export function langFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? ''
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : ''
  return EXT[ext] ?? 'plaintext'
}

export async function highlightHtml(code: string, lang: string): Promise<string> {
  const hl = await highlighter()
  let resolved = lang
  if (!hl.getLoadedLanguages().includes(lang)) {
    try {
      await hl.loadLanguage(lang as BundledLanguage)
    } catch {
      resolved = 'plaintext'
    }
  }
  return hl.codeToHtml(code, { lang: resolved, theme: 'github-dark' })
}

export function useHighlightHtml(code: string, lang: string): string | undefined {
  const [html, setHtml] = useState<string>()
  useEffect(() => {
    let cancelled = false
    setHtml(undefined)
    void highlightHtml(code, lang).then((next) => {
      if (!cancelled) setHtml(next)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])
  return html
}
