import type { Translate } from '../../../shared/i18n'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'

/** Log-scale buckets (4 KB × 4^n), so the dots read as a magnitude instead of a counted value. */
const sizeThresholds = [4, 16, 64, 256, 1024, 4096, 16384, 65536].map((kb) => kb * 1024)

function formatSize(bytes: number, t: Translate): string {
  if (bytes < 1024) return t('common.bytes', { n: bytes })
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/** How heavy a session is, as crossed thresholds; the exact weight stays in the accessible name. */
export function SessionSizeDots({ size, className }: { size: number; className?: string }) {
  const t = useT()
  return (
    <span
      className={cn('flex items-center gap-0.5', className)}
      role="img"
      aria-label={t('sessions.sizeAria', { size: formatSize(size, t) })}
    >
      {sizeThresholds.map((threshold) => (
        <span
          key={threshold}
          className={cn(
            'size-1 rounded-full',
            threshold <= size ? 'bg-primary' : 'bg-muted-foreground/25'
          )}
        />
      ))}
    </span>
  )
}
