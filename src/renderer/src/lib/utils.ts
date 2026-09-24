import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export const hideScroll = '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
