/**
 * Bounded reads shared by the changes panel and the file tabs: a file is read into a buffer that is one
 * byte larger than its cap, so the read itself can tell "that was all of it" from "there was more",
 * and the probe that decides whether the bytes are text at all. The errno translation lives here too,
 * because every write in the file column — a draft, a new entry, a rename — owes the reader the same
 * words for the same failures.
 */
import type { FileHandle } from 'node:fs/promises'
import { t } from '../i18n'

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

/** A write that failed in a way the reader can act on says so in its own words, not in errno's. */
export function writeFailure(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code
  const reason =
    code === 'EACCES' || code === 'EPERM'
      ? t('error.noWritePermission')
      : code === 'EISDIR'
        ? t('error.isDirectory')
        : code === 'ENOENT'
          ? t('error.missingDirectory')
          : code === 'ENOSPC'
            ? t('error.noSpace')
            : code === 'EROFS'
              ? t('error.readOnlyFilesystem')
              : null
  if (!reason) return error instanceof Error ? error : new Error(String(error))
  return new Error(reason)
}
