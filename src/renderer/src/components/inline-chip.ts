/**
 * Shared look for chips that sit inside a line of prompt text: file references and pasted text.
 * The height stays near the composer's line height so a caret drawn beside a chip matches one in text.
 * Middle, not baseline: an inline-flex box takes its baseline from the leading icon's bottom edge,
 * which would lift the chip above the text. Middle in turn means half an x-height above the
 * baseline, below the visual center of CJK glyphs and the caret, so the chip is raised 0.1em.
 */
export const INLINE_CHIP_CLASS = 'relative -top-[0.1em] mx-0.5 h-5 max-w-60 gap-1 rounded-md px-1.5 align-middle'
