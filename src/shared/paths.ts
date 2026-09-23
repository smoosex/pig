/**
 * Portable path spellings both sides agree on: no fs, no Electron, no React — main scores them,
 * the renderer renders them.
 */

/** The last segment: `src/main/index.ts` reads as `index.ts`, `src/main/` as `main`. */
export function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}
