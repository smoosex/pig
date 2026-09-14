export const TURN_ALIGN = 12
export const SCROLL_END = 32

export type ScrollSnapshot = {
  scrollTop: number
  following: boolean
  anchor: { key: string; offset: number } | null
}
