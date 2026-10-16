/** Registers the `pig-file` scheme the markdown preview loads worktree images through. */
import { protocol } from 'electron'
import { WORKTREE_FILE_SCHEME } from '../shared/worktree-files'
import { worktreeImageResponse } from './files/image'

/** Call before app ready; the privileges cannot be granted afterwards. */
export function registerWorktreeFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WORKTREE_FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export function handleWorktreeFiles(): void {
  protocol.handle(WORKTREE_FILE_SCHEME, (request) => worktreeImageResponse(request.url))
}
