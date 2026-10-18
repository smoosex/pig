import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

export const hideScroll = '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'

/**
 * The `--shadow-glass-*` theme tokens are box-shadow sizes. tailwind-merge does not know them and would
 * read `shadow-glass-card` as a shadow color, so a caller's `shadow-none` could not replace it.
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { shadow: [(value: string) => value.startsWith('glass-')] } }
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
