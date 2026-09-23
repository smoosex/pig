import { LOCALES, translate } from '../../../../shared/i18n'
import type { MessageKey } from '../../../../shared/i18n'
import { t } from '../../lib/i18n'
import type { SessionMeta, SessionPreviewFallback } from '../../ipc/api'

const FALLBACK_KEYS: Record<SessionPreviewFallback, MessageKey> = {
  pastedText: 'composer.pastedText',
  image: 'common.image'
}

/** The word an app-written preview title shows, translated now rather than when it was written. */
export function fallbackTitle(fallback: SessionPreviewFallback): string {
  return t(FALLBACK_KEYS[fallback])
}

export function sessionTitle(session: SessionMeta, fallback = t('sessions.newTitle')): string {
  if (session.name) return session.name
  if (session.previewFallback) return fallbackTitle(session.previewFallback)
  const first = session.firstMessageIsImage ? t('sessions.imagePreview') : session.firstMessage
  return first || fallback
}

/** A stored title is a placeholder if it is still the untouched label in whichever language wrote it. */
const PLACEHOLDER_TITLES = new Set(LOCALES.map((locale) => translate(locale, 'sessions.newTitle')))

export function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title)
}
