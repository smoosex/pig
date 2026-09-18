import { useEffect, useState, type RefObject } from 'react'
import { getSharedHighlighter, type DiffsHighlighter } from '@pierre/diffs'
import { useDarkMode } from './useDarkMode'

type HighlightTheme = 'github-dark' | 'github-light'

const THEMES: HighlightTheme[] = ['github-dark', 'github-light']
const SEED_LANGS = ['text', 'typescript', 'tsx', 'javascript', 'jsx', 'json']
const TEXT_ALIASES = new Set(['text', 'plaintext', 'txt'])

/**
 * The diff renderer and the transcript share one Shiki highlighter: the module-level singleton owned
 * by @pierre/diffs. `preferredHighlighter` only counts on the call that creates the instance, and the
 * WASM engine is several times faster than the JS regex engine on real sessions, so every path asks
 * for it. Grammar resolution and the theme cache are the library's, which is why this module no
 * longer keeps a highlighter of its own. A creation failure is not retried by the library, so a
 * broken engine leaves code blocks unhighlighted for the rest of the session.
 */
function sharedHighlighter(langs: string[]): Promise<DiffsHighlighter> {
  return getSharedHighlighter({ themes: THEMES, langs, preferredHighlighter: 'shiki-wasm' })
}

/** A transcript can name any extension, and an unknown language throws instead of degrading. */
async function resolveHighlightLanguage(lang: string): Promise<string> {
  if (TEXT_ALIASES.has(lang)) return 'text'
  try {
    await getSharedHighlighter({ themes: [], langs: [lang], preferredHighlighter: 'shiki-wasm' })
    return lang
  } catch {
    return 'text'
  }
}

/** Engine startup and grammar compiles would otherwise happen while the first transcript paints. */
export function prewarmHighlighter(): void {
  void sharedHighlighter(SEED_LANGS).catch((error) =>
    console.warn('shiki highlighter warm-up failed:', error)
  )
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

const MAX_CACHE_CHARS = 4_000_000
const MAX_CACHE_ENTRIES = 200
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()
let cacheChars = 0

async function renderHighlight(code: string, lang: string, theme: HighlightTheme): Promise<string> {
  const [hl, resolved] = await Promise.all([sharedHighlighter(SEED_LANGS), resolveHighlightLanguage(lang)])
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

function useInView(ref?: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(!ref || typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const element = ref?.current
    if (!ref || !element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = sharedObserver()
    watchers.set(element, () => setVisible(true))
    observer.observe(element)
    return () => {
      watchers.delete(element)
      observer.unobserve(element)
    }
  }, [ref])
  return visible
}

// Mounted turns can hold hundreds of code blocks while only a couple of them are on screen, so
// highlighting waits until a block is close to the viewport and then never undoes itself.
// The blocks live in a nested scroller (MessageScrollerViewport): rootMargin alone is measured
// against the viewport and cannot see past that clip, so the margin has to come from scrollMargin.
const VIEWPORT_MARGIN = '600px 0px'
const watchers = new WeakMap<Element, () => void>()
let visibility: IntersectionObserver | undefined

function sharedObserver(): IntersectionObserver {
  visibility ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const notify = watchers.get(entry.target)
      watchers.delete(entry.target)
      visibility?.unobserve(entry.target)
      notify?.()
    }
  }, { rootMargin: VIEWPORT_MARGIN, scrollMargin: VIEWPORT_MARGIN })
  return visibility
}

export function useHighlightHtml(code: string, lang: string, ref?: RefObject<Element | null>): string | undefined {
  const theme = useDarkMode() ? 'github-dark' : 'github-light'
  const visible = useInView(ref)
  const [result, setResult] = useState<{ code: string; lang: string; theme: HighlightTheme; html: string }>()
  useEffect(() => {
    if (!visible) return
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
  }, [code, lang, theme, visible])
  return result?.code === code && result.lang === lang && result.theme === theme ? result.html : undefined
}
