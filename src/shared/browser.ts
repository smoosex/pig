/** Host-owned browser panes and immutable element selections, independent of Pi session lifetimes. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
  bottomLeftRadius?: number
  bottomRightRadius?: number
  /** Open DevTools take this much of the bottom of these bounds. */
  devtools?: { height: number }
}

export interface BrowserCertificateError {
  /** The URL that failed to load; allowing the certificate reloads it. */
  url: string
  /** host[:port] the exception applies to. */
  host: string
  /** Chromium error, e.g. net::ERR_CERT_AUTHORITY_INVALID. */
  error: string
  issuer: string
  subject: string
  /** Seconds since the epoch. */
  validExpiry: number
  /** SHA-256 fingerprint as reported by Chromium ("sha256/..."). */
  fingerprint: string
}

export interface BrowserState {
  browserId: string
  documentId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  selecting: boolean
  /** The page's DevTools are docked below it inside the same pane. */
  devtools: boolean
  /** Transient push when the native webpage takes focus; not persisted in page state. */
  focused?: boolean
  annotations: BrowserAnnotation[]
  error: string | null
  /** The main document failed certificate verification; only the user can allow it from the pane. */
  certificate: BrowserCertificateError | null
  /** The Pi session whose agent controls this page through the browser tools, if any. */
  agentSessionId: string | null
}

/** Agent tab changes round-trip through the owning UI, which holds tab-strip state. */
export type BrowserAgentOpenRequest = { requestId: string; sessionId: string } & (
  | { action?: 'open' }
  | { action: 'activate' | 'close'; browserId: string }
)

export interface BrowserScreenshot {
  mimeType: 'image/png'
  data: string
}

export interface BrowserElement {
  selector: string
  tagName: string
  role: string
  name: string
  text: string
  bounds: BrowserBounds
  styles: Record<string, string>
}

export interface BrowserSelection {
  id: string
  browserId: string
  documentId: string
  url: string
  title: string
  element: BrowserElement
  capturedAt: number
}

export interface BrowserAnnotation extends BrowserSelection {
  ordinal: number
  comment: string
}

export interface BrowserMarker {
  id: string
  ordinal: number
  documentId: string
  selector: string
  comment: string
}

export interface BrowserPickerOptions {
  labels: { comment: string; add: string; cancel: string; remove: string; update: string }
  theme: {
    background: string; foreground: string; border: string; muted: string
    primary: string; primaryForeground: string; input: string; ring: string; shadow: string; destructive: string
  }
}

export type BrowserCookieScope = 'site' | 'all'

export interface BrowserCookieSource {
  id: string
  browser: 'chrome'
  name: string
}

export interface BrowserCookieSkips {
  expired: number
  partitioned: number
  unsupported: number
}

export interface BrowserCookieSources {
  supported: boolean
  site: string | null
  sources: BrowserCookieSource[]
}

/** Cookie names and values never cross the host/UI boundary. Preview counts may change before import. */
export interface BrowserCookiePreview {
  site: string | null
  count: number
  domains: { domain: string; count: number }[]
  skipped: BrowserCookieSkips
}

export interface BrowserCookieImportResult {
  imported: number
  failed: number
  skipped: BrowserCookieSkips
}

export interface BrowserCookieClearResult {
  removed: number
  failed: number
}

/** Only the Pig UI can create/control these panes; page guests never receive this API. */
export interface BrowserApi {
  /** `url` is a restored tab's saved page, loaded once the pane is first shown. */
  create(browserId: string, url?: string): Promise<BrowserState>
  getState(browserId: string): Promise<BrowserState>
  navigate(browserId: string, url: string): Promise<void>
  back(browserId: string): Promise<void>
  forward(browserId: string): Promise<void>
  reload(browserId: string): Promise<void>
  setBounds(browserId: string, bounds: BrowserBounds | null): Promise<void>
  setSelecting(browserId: string, selecting: boolean, options?: BrowserPickerOptions): Promise<void>
  removeAnnotations(browserId: string, ids: string[]): Promise<void>
  capture(browserId: string): Promise<BrowserScreenshot>
  /** Best-effort still frame shown while DOM overlays force the native view hidden; null when not ready. */
  snapshot(browserId: string): Promise<string | null>
  copyUrl(browserId: string): Promise<void>
  openExternal(browserId: string): Promise<void>
  inspect(browserId: string): Promise<void>
  /** Trusts the page's untrusted certificate for its host until Pig quits, then reloads it. */
  allowCertificate(browserId: string, fingerprint: string): Promise<void>
  close(browserId: string): Promise<void>
  listCookieSources(browserId: string): Promise<BrowserCookieSources>
  previewCookies(browserId: string, sourceId: string, scope: BrowserCookieScope): Promise<BrowserCookiePreview>
  importCookies(browserId: string, sourceId: string, scope: BrowserCookieScope, expectedSite: string | null): Promise<BrowserCookieImportResult>
  clearSiteCookies(browserId: string, expectedSite: string): Promise<BrowserCookieClearResult>
  onCloseRequested(listener: (browserId: string) => void): () => void
  /** Pointer position (renderer CSS px) while the user drags the top edge of docked DevTools. */
  onDevtoolsResize(listener: (browserId: string, clientY: number) => void): () => void
  onShortcutRequested(listener: (action: BrowserHostShortcut) => void): () => void
  /** Ends agent control of the page; the agent must call browser_open again to resume. */
  releaseAgent(browserId: string, expectedSessionId?: string): Promise<void>
  onAgentOpenRequest(listener: (request: BrowserAgentOpenRequest) => void): () => void
  /** Answers an agent open request with the created tab, or the reason it could not be created. */
  answerAgentOpen(requestId: string, result: { browserId: string } | { error: string }): Promise<void>
  onState(listener: (state: BrowserState) => void): () => void
  onSelection(listener: (selection: BrowserSelection) => void): () => void
}

export type BrowserHostShortcut = 'close-active-tab' | 'toggle-sidebar' | 'toggle-workspace' | 'toggle-settings' | 'open-project'
export const BROWSER_SHORTCUT_CHANNEL = 'browser:host-shortcut-requested'
export const BROWSER_CLOSE_TAB_CHANNEL = 'browser:close-tab-requested'
export const BROWSER_DEVTOOLS_RESIZE_CHANNEL = 'browser:devtools-resize'
export const BROWSER_PICKER_CHANNEL = 'browser:picker'
export const BROWSER_SELECTION_CHANNEL = 'browser:element-selected'
export const BROWSER_PICKER_CANCEL_CHANNEL = 'browser:picker-cancelled'
export const BROWSER_MARKER_REMOVE_CHANNEL = 'browser:marker-remove'
export const BROWSER_MARKER_UPDATE_CHANNEL = 'browser:marker-update'
