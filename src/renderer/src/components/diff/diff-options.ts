import type { FileDiffOptions, FileOptions } from '@pierre/diffs/react'
import type { DiffStyle } from '../../stores/diff'

/**
 * Every diff surface in Pig renders through @pierre/diffs with the same options: the app draws its own
 * file headers, the shared highlighter is asked for the WASM engine, and the library's inner
 * horizontal scrollbars are hidden because the page hides its own.
 */

/**
 * A code surface takes the color of the container it sits in. The library would fill it with the Shiki
 * theme's own background instead (github-dark's #24292e), which is a color from outside Pig's palette;
 * `--diffs-bg` is the single variable every part of the surface derives from — gutter, buffer, separators
 * and the mixed diff-line colors — so pointing it at the code background is what makes the whole area the
 * same color as the pane. The override rides in the library's `unsafe` layer, which is the one that wins
 * over its own defaults.
 *
 * Reading panes opt into `glass-code-surface`, which makes the base transparent in glass: the library's
 * color-mix derivations then turn into translucent tints of the same hues over the conversation material.
 * The edit tool's diff in the conversation opts in too; anything outside the utility keeps the opaque code background.
 *
 * The sticky gutter overlays horizontally scrolled code. Reading panes use a translucent fill and
 * localized backdrop blur in glass; solid and surfaces outside the utility retain their opaque, unfiltered gutter.
 */
const codeSurfaceCSS = [
  ':host { --diffs-bg: var(--code-surface-background, var(--code-background)) }',
  '[data-gutter] { background-color: var(--code-surface-gutter-background, var(--diffs-bg)); backdrop-filter: var(--code-surface-gutter-filter, none) }',
  'code { scrollbar-width: none } code::-webkit-scrollbar { display: none }'
].join('\n')

export function fileDiffOptions(dark: boolean, style: DiffStyle): FileDiffOptions<undefined, undefined> {
  return {
    theme: { light: 'github-light', dark: 'github-dark' },
    themeType: dark ? 'dark' : 'light',
    preferredHighlighter: 'shiki-wasm',
    diffStyle: style,
    diffIndicators: 'bars',
    hunkSeparators: 'line-info-basic',
    disableFileHeader: true,
    unsafeCSS: codeSurfaceCSS
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
    unsafeCSS: codeSurfaceCSS
  }
}
