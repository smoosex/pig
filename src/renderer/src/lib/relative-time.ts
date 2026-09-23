import type { Translate } from '../../../shared/i18n'

/** The caller passes its translator so the row re-renders with the language it is drawn in. */
export function relativeTime(value: string, t: Translate): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ''
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return t('time.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('time.daysAgo', { n: days })
  const months = Math.floor(days / 30)
  if (months < 12) return t('time.monthsAgo', { n: months })
  return t('time.yearsAgo', { n: Math.floor(days / 365) })
}
