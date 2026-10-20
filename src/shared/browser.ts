/** Host-owned browser panes and immutable element selections, independent of Pi session lifetimes. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
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
}

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

/** Only the Pig UI can create/control these panes; page guests never receive this API. */
export interface BrowserApi {
  create(browserId: string): Promise<BrowserState>
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
  close(browserId: string): Promise<void>
  onState(listener: (state: BrowserState) => void): () => void
  onSelection(listener: (selection: BrowserSelection) => void): () => void
}

export const BROWSER_PICKER_CHANNEL = 'browser:picker'
export const BROWSER_SELECTION_CHANNEL = 'browser:element-selected'
export const BROWSER_PICKER_CANCEL_CHANNEL = 'browser:picker-cancelled'
export const BROWSER_MARKER_REMOVE_CHANNEL = 'browser:marker-remove'
export const BROWSER_MARKER_UPDATE_CHANNEL = 'browser:marker-update'
