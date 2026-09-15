export const TURN_ALIGN = 12
export const SCROLL_END = 32

export type ScrollSnapshot = {
  scrollTop: number
  following: boolean
  /** `index` is where the row sits in the branch, and is unknown while the window is provisional. */
  anchor: { key: string; offset: number; index?: number } | null
}
