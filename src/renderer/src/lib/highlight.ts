import { useEffect, useState } from 'react'
import {
  createHighlighter,
  createJavaScriptRegexEngine,
  bundledLanguages,
  type BundledLanguage,
  type Highlighter
} from 'shiki'
import { useDarkMode } from './useDarkMode'

const engine = createJavaScriptRegexEngine({ forgiving: true })

let ready: Promise<Highlighter> | undefined

function highlighter(): Promise<Highlighter> {
  ready ??= createHighlighter({
    engine,
    themes: ['github-dark', 'github-light'],
    langs: ['plaintext', 'typescript', 'tsx', 'javascript', 'jsx', 'json']
  }).catch((error) => {
    ready = undefined
    throw error
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

type HighlightTheme = 'github-dark' | 'github-light'
const MAX_CACHE_CHARS = 1_000_000
const MAX_CACHE_ENTRIES = 64
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()
const loadingLanguages = new Map<string, Promise<void>>()
let cacheChars = 0

async function renderHighlight(code: string, lang: string, theme: HighlightTheme): Promise<string> {
  const hl = await highlighter()
  let resolved = lang in bundledLanguages ? lang : 'plaintext'
  if (resolved !== 'plaintext' && !hl.getLoadedLanguages().includes(resolved)) {
    try {
      let loading = loadingLanguages.get(resolved)
      if (!loading) {
        const language = resolved
        loading = hl.loadLanguage(language as BundledLanguage).finally(() => loadingLanguages.delete(language))
        loadingLanguages.set(language, loading)
      }
      await loading
    } catch {
      resolved = 'plaintext'
    }
  }
  return hl.codeToHtml(code, { lang: resolved, theme })
}

/** Share repeated work across mounted code blocks and bound retained HTML for long sessions. */
export function highlightHtml(code: string, lang: string, theme: HighlightTheme = 'github-dark'): Promise<string> {
  const key = `${theme}\0${lang}\0${code}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return Promise.resolve(cached)
  }
  const existing = pending.get(key)
  if (existing) return existing
  const promise = renderHighlight(code, lang, theme).then((html) => {
    const size = key.length + html.length
    if (size <= MAX_CACHE_CHARS) {
      while (cache.size && (cache.size >= MAX_CACHE_ENTRIES || cacheChars + size > MAX_CACHE_CHARS)) {
        const oldest = cache.keys().next().value!
        cacheChars -= oldest.length + cache.get(oldest)!.length
        cache.delete(oldest)
      }
      cache.set(key, html)
      cacheChars += size
    }
    return html
  }).finally(() => pending.delete(key))
  pending.set(key, promise)
  return promise
}

export function useHighlightHtml(code: string, lang: string): string | undefined {
  const theme = useDarkMode() ? 'github-dark' : 'github-light'
  const [result, setResult] = useState<{ code: string; lang: string; theme: HighlightTheme; html: string }>()
  useEffect(() => {
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      void highlightHtml(code, lang, theme).then(
        (html) => { if (!cancelled) setResult({ code, lang, theme, html }) },
        () => { if (!cancelled) setResult(undefined) }
      )
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [code, lang, theme])
  return result?.code === code && result.lang === lang && result.theme === theme ? result.html : undefined
}
