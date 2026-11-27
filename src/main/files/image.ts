/**
 * Local images for file tabs, Markdown previews, and chat replies, served behind the `pig-file` scheme.
 *
 * `pig-file://worktree/<cwd>/<path>` enforces the same worktree root and path-traversal guards as a
 * file tab. `pig-file://local/<path>` serves explicit absolute or `~/` image files referenced in chat
 * replies. Both refuse non-image extensions, non-regular files, and symlinks at the final segment.
 */
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  MAX_WORKTREE_IMAGE_BYTES,
  parseLocalImageFileUrl,
  parseWorktreeFileUrl,
  worktreeImageMimeType
} from '../../shared/worktree-files'
import { readLanes } from '../git/limit'
import { openedWorktree } from '../worktree-access'
import { expandLocalInputPath } from './file'
import { resolveWorktreePath } from './paths'
import { isMissingError, readCapped } from './read'

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)

const notFound = (): Response => new Response(null, { status: 404 })

async function serveImageFile(absolutePath: string, type: string): Promise<Response> {
  try {
    const bytes = await readLanes.run(async () => {
      const handle = await open(absolutePath, OPEN_FLAGS)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > MAX_WORKTREE_IMAGE_BYTES) return null
        const buffer = Buffer.allocUnsafe(info.size)
        return buffer.subarray(0, await readCapped(handle, buffer))
      } finally {
        await handle.close()
      }
    })
    if (!bytes) return notFound()
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        // The file can change under the same URL while the preview is open.
        'cache-control': 'no-cache'
      }
    })
  } catch (error) {
    // A link at the last segment, a non-regular file, or a file that is gone renders as missing.
    const code = (error as NodeJS.ErrnoException).code
    if (
      code === 'ELOOP' ||
      code === 'EMLINK' ||
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'ENXIO' ||
      isMissingError(error)
    ) {
      return notFound()
    }
    throw error
  }
}

async function localImageResponse(rawPath: string): Promise<Response> {
  const type = worktreeImageMimeType(rawPath)
  if (!type) return notFound()
  const target = expandLocalInputPath(rawPath)
  if (!target) return notFound()
  const parent = dirname(target)
  const resolvedParent = parent === target
    ? target
    : await realpath(parent).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code
        if (isMissingError(error) || code === 'EACCES' || code === 'EPERM') return null
        throw error
      })
  if (!resolvedParent) return notFound()
  const absolute = parent === target ? target : join(resolvedParent, basename(target))
  return serveImageFile(absolute, type)
}

export async function worktreeImageResponse(url: string): Promise<Response> {
  const localPath = parseLocalImageFileUrl(url)
  if (localPath !== null) return localImageResponse(localPath)

  const target = parseWorktreeFileUrl(url)
  if (!target) return notFound()
  const type = worktreeImageMimeType(target.path)
  if (!type) return notFound()
  const root = await openedWorktree(target.cwd)
  if (!root) return notFound()
  const file = await resolveWorktreePath(root, target.path, 'file')
  if (!file) return notFound()
  return serveImageFile(file.absolute, type)
}
