/**
 * One worktree image for the markdown preview, behind the `pig-file` scheme.
 *
 * The URL is a request from the renderer, so it gets the same treatment as a file tab read: the cwd has
 * to be an opened worktree, the path is resolved without letting a link lead outside it, and the file's
 * own segment is never followed. Only image types are served, with their content type fixed by the
 * extension, so the scheme cannot be used to read arbitrary files back as text.
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseWorktreeFileUrl } from '../../shared/worktree-files'
import { readLanes } from '../git/limit'
import { openedWorktree } from '../worktree-access'
import { resolveWorktreePath } from './paths'
import { isMissingError, readCapped } from './read'

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const notFound = (): Response => new Response(null, { status: 404 })

export async function worktreeImageResponse(url: string): Promise<Response> {
  const target = parseWorktreeFileUrl(url)
  if (!target) return notFound()
  const type = IMAGE_TYPES[extname(target.path).slice(1).toLowerCase()]
  if (!type) return notFound()
  const root = await openedWorktree(target.cwd)
  if (!root) return notFound()
  const file = await resolveWorktreePath(root, target.path, 'file')
  if (!file) return notFound()
  try {
    const bytes = await readLanes.run(async () => {
      const handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null
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
    // A link at the last segment and a file that is gone are images that do not exist for the preview.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP' || isMissingError(error)) return notFound()
    throw error
  }
}
