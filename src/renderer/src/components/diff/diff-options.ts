import type { FileDiffOptions, FileOptions } from '@pierre/diffs/react'
import type { DiffStyle } from '../../stores/diff'

/**
 * Every diff surface in Pig renders through @pierre/diffs with the same options: the app draws its own
 * file headers, the shared highlighter is asked for the WASM engine, and the library's inner
 * horizontal scrollbars are hidden because the page hides its own.
 */

export function fileDiffOptions(dark: boolean, style: DiffStyle): FileDiffOptions<undefined, undefined> {
  return {
    theme: { light: 'github-light', dark: 'github-dark' },
    themeType: dark ? 'dark' : 'light',
    preferredHighlighter: 'shiki-wasm',
    diffStyle: style,
    diffIndicators: 'bars',
    hunkSeparators: 'line-info-basic',
    disableFileHeader: true,
    unsafeCSS: 'code { scrollbar-width: none } code::-webkit-scrollbar { display: none }'
  }
}

/**
 * A whole file for a file tab: the same theme contract and highlighter as the diff surfaces, with the
 * library's header off because the tab draws the file's name and its own actions itself.
 */
export function fileCodeOptions(dark: boolean): FileOptions<undefined, undefined> {
  return {
    theme: { light: 'github-light', dark: 'github-dark' },
    themeType: dark ? 'dark' : 'light',
    preferredHighlighter: 'shiki-wasm',
    disableFileHeader: true,
    unsafeCSS: 'code { scrollbar-width: none } code::-webkit-scrollbar { display: none }'
  }
}
