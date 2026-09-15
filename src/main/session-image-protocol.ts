/**
 * The `pig-image` scheme serves images persisted in session entries.
 *
 * Registering it as a standard, secure scheme lets the renderer load `pig-image` URLs like any
 * other subresource, so the browser only loads the images it renders.
 */
import { protocol } from 'electron'
import { SESSION_IMAGE_SCHEME } from '../shared/session-images'
import { sessionImageResponse } from './pi/session-images'
import { findSessionManager } from './pi/session-registry'

/** Call before app ready; the privileges cannot be granted afterwards. */
export function registerSessionImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SESSION_IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export function handleSessionImages(): void {
  protocol.handle(SESSION_IMAGE_SCHEME, (request) => sessionImageResponse(request.url, findSessionManager))
}
