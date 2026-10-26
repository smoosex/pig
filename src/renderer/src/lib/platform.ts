/** Chromium reports `MacIntel` on every Mac; DOM test environments derive theirs from `Darwin`. */
export const IS_MAC = /Mac|Darwin/.test(navigator.platform)
