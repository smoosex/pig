/**
 * xterm instances for terminal tabs. Each one lives as long as its tab, not its React view: switching
 * tabs or moving a pane parks the element off-screen and reattaches it, so scrollback and running
 * programs never need replaying. The shell starts on the first mount, once the font is loaded and the
 * grid has a real size; closing the tab disposes the instance and asks main to end the shell.
 */
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { api } from '../ipc/api'
import { t } from '../lib/i18n'
import { useSessionsStore } from '../stores/sessions'
import { TERMINAL_COLS, TERMINAL_ROWS, TERMINAL_MAX_WRITE, type TerminalEvent } from '../../../shared/terminal'

export const TERMINAL_FONT_FAMILY = "'Lilex Nerd Font Mono', monospace"
const FONT_SIZE = 13
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

interface Entry {
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  status: 'starting' | 'running' | 'ended'
  /** Focus asked for before the font loaded and xterm opened. */
  focusOnOpen: boolean
}

const entries = new Map<string, Entry>()
let parking: HTMLDivElement | null = null
let fontsReady: Promise<unknown> | null = null

/** Palette tokens resolved to literal colours; the background stays clear so the pane surface shows. */
function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(`--terminal-${name}`).trim()
  const theme: ITheme = {
    background: 'rgba(0, 0, 0, 0)',
    foreground: token('foreground'),
    cursor: token('cursor'),
    cursorAccent: token('foreground'),
    selectionBackground: token('selection')
  }
  const colors = theme as Record<string, string>
  for (const name of ANSI) {
    colors[name] = token(name)
    colors[`bright${name[0].toUpperCase()}${name.slice(1)}`] = token(`bright-${name}`)
  }
  return theme
}

function notice(term: Terminal, text: string): void {
  term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
}

function reportError(id: string, error: unknown): void {
  const entry = entries.get(id)
  if (!entry || entry.status === 'ended') return
  entry.status = 'ended'
  notice(entry.term, t('terminal.failed', { message: error instanceof Error ? error.message : String(error) }))
}

function receive(event: TerminalEvent): void {
  const entry = entries.get(event.terminalId)
  if (!entry) return
  if (event.kind === 'output') {
    // Acknowledge once xterm has parsed the chunk, which is what lets the PTY host release a paused shell.
    entry.term.write(event.data, () => {
      if (entry.status !== 'ended') api.terminal.ack(event.terminalId, event.data.length).catch((error) => reportError(event.terminalId, error))
    })
    return
  }
  entry.status = 'ended'
  notice(entry.term, event.kind === 'exit'
    ? t('terminal.exited', { code: event.exitCode })
    : t('terminal.failed', { message: event.message }))
}

let installed = false
function install(): void {
  if (installed) return
  installed = true
  api.terminal.onEvent(receive)
  // One observer for every instance: palette, appearance and surface style all live on <html>.
  new MutationObserver(() => {
    const theme = readTheme()
    for (const entry of entries.values()) entry.term.options.theme = theme
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-palette', 'data-surface-style', 'style'] })
  // Tabs leave the strip through many paths (close, project removal, window restore); all end here.
  useSessionsStore.subscribe((state, previous) => {
    if (state.openTabs === previous.openTabs) return
    const remaining = new Set(state.openTabs.map((tab) => tab.id))
    for (const id of [...entries.keys()]) if (!remaining.has(id)) dispose(id)
  })
  parking = document.createElement('div')
  parking.setAttribute('aria-hidden', 'true')
  parking.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;overflow:hidden;visibility:hidden'
  document.body.append(parking)
}

function dispose(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
  entry.term.dispose()
  entry.element.remove()
  api.terminal.close(id).catch((error: unknown) => {
    useSessionsStore.setState({ workspaceError: error instanceof Error ? error.message : String(error) })
  })
}

function create(id: string, cwd: string | null, host: HTMLElement): Entry {
  const element = document.createElement('div')
  element.className = 'size-full'
  host.append(element)
  const term = new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: FONT_SIZE,
    lineHeight: 1.2,
    cursorBlink: true,
    allowTransparency: true,
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: false,
    theme: readTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(new WebLinksAddon((event, uri) => {
    // Plain clicks select text; the modifier opens, as in VS Code. Main routes window.open to the system browser.
    if (event.metaKey || event.ctrlKey) window.open(uri, '_blank')
  }))
  term.attachCustomKeyEventHandler((event) => {
    // App shortcuts use Command, as in App.tsx; Control stays terminal input.
    if (!event.metaKey || event.ctrlKey || event.altKey) return true
    // Shift variants belong to the app (Cmd+Shift+A adds a project).
    if (event.type === 'keydown' && !event.shiftKey && event.key.toLowerCase() === 'k') {
      term.clear()
      return false
    }
    if (event.type === 'keydown' && !event.shiftKey && event.key.toLowerCase() === 'a') {
      term.selectAll()
      return false
    }
    // Copy and paste stay with xterm; every other Command shortcut belongs to the app.
    return event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 'v'
  })
  const entry: Entry = { term, fit, element, status: 'starting', focusOnOpen: false }
  entries.set(id, entry)
  const sendInput = (data: string, binary = false): void => {
    if (entry.status !== 'running') return
    // Invoke messages preserve send order, including the next key after a paste. Never split a surrogate pair.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + TERMINAL_MAX_WRITE, data.length)
      const last = data.charCodeAt(end - 1)
      if (end < data.length && last >= 0xd800 && last <= 0xdbff && data.charCodeAt(end) >= 0xdc00 && data.charCodeAt(end) <= 0xdfff) end--
      // A rejected input request is an operation error, not evidence that the shell exited.
      api.terminal.write(id, data.slice(offset, end), binary).catch((error: unknown) => {
        if (entries.get(id) !== entry) return
        notice(term, t('terminal.writeFailed', { message: error instanceof Error ? error.message : String(error) }))
      })
      offset = end
    }
  }
  term.onData((data) => sendInput(data))
  term.onBinary((data) => sendInput(data, true))
  term.onResize(({ cols, rows }) => {
    if (entry.status === 'running') api.terminal.resize(id, cols, rows).catch((error) => reportError(id, error))
  })

  fontsReady ??= Promise.all(['400', '700'].map((weight) => document.fonts.load(`${weight} ${FONT_SIZE}px 'Lilex Nerd Font Mono'`)))
  const fonts = fontsReady
  void fonts.then(() => null, (error: unknown) => {
    // Let the next terminal retry instead of every later pane inheriting this rejection.
    if (fontsReady === fonts) fontsReady = null
    return error
  }).then(async (fontError) => {
    if (entries.get(id) !== entry) return
    // The grid is measured from the font, so the shell must not start before it settled.
    term.open(element)
    // xterm falls back to the next monospace family; the failure is shown rather than leaving a blank pane.
    if (fontError) notice(term, t('terminal.fontFailed', { message: fontError instanceof Error ? fontError.message : String(fontError) }))
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (error) {
      // No WebGL context (GPU blocklist, too many contexts): xterm keeps its DOM renderer.
      console.warn('Terminal WebGL renderer unavailable:', error)
    }
    fitVisible(entry)
    if (entry.focusOnOpen) term.focus()
    try {
      await api.terminal.create(id, cwd, term.cols, term.rows)
    } catch (error) {
      if (entries.get(id) !== entry) return
      entry.status = 'ended'
      notice(term, t('terminal.startFailed', { message: error instanceof Error ? error.message : String(error) }))
      return
    }
    if (entries.get(id) !== entry || entry.status !== 'starting') return
    entry.status = 'running'
    // The pane may have been resized while the shell was starting.
    if (fitVisible(entry)) api.terminal.resize(id, term.cols, term.rows).catch((error) => reportError(id, error))
  }).catch((error: unknown) => reportError(id, error))
  return entry
}

/** Fits the grid to its element; a parked or collapsed element has no size to fit. */
function fitVisible(entry: Entry): boolean {
  if (!entry.element.isConnected || !entry.term.element || !entry.element.clientWidth || !entry.element.clientHeight) return false
  const dimensions = entry.fit.proposeDimensions()
  if (!dimensions) return false
  if (!Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) throw new Error('Invalid terminal dimensions')
  // Clamp before xterm emits onResize so the grid and PTY always use the same accepted dimensions.
  const cols = Math.max(TERMINAL_COLS.min, Math.min(TERMINAL_COLS.max, Math.floor(dimensions.cols)))
  const rows = Math.max(TERMINAL_ROWS.min, Math.min(TERMINAL_ROWS.max, Math.floor(dimensions.rows)))
  if (entry.term.cols !== cols || entry.term.rows !== rows) entry.term.resize(cols, rows)
  return true
}

/** Shows the tab's terminal inside `host`, creating it on first use; returns the detach function. */
export function attachTerminal(id: string, cwd: string | null, host: HTMLElement): () => void {
  install()
  const entry = entries.get(id) ?? create(id, cwd, host)
  host.append(entry.element)
  let frame = 0
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => fitVisible(entry))
  })
  observer.observe(host)
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
    if (entries.get(id) === entry) {
      entry.focusOnOpen = false
      parking!.append(entry.element)
    }
  }
}

export function setTerminalActive(id: string, active: boolean): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.focusOnOpen = active && !entry.term.element
  if (active && entry.term.element) entry.term.focus()
}
