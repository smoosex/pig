/**
 * Bounded reads shared by the changes panel and the file tabs: a file is read into a buffer that is one
 * byte larger than its cap, so the read itself can tell "that was all of it" from "there was more",
 * and the probe that decides whether the bytes are text at all.
 */
import type { FileHandle } from 'node:fs/promises'

/** How far into a file to look for a NUL byte before calling it binary. */
export const BINARY_PROBE_BYTES = 8000

/** Fills the buffer from the start of an open file, stopping at its end or when the buffer is full. */
export async function readCapped(handle: FileHandle, buffer: Buffer): Promise<number> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset
}

/**
 * The two codes that mean "that path is not there". Shared by every read and by the count validation,
 * so one errno list describes what a missing file is everywhere.
 */
export function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
