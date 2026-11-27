/**
 * Interactive image viewport for a file tab: fit-to-pane display with wheel/pinch zoom, drag panning,
 * double-click zoom toggle, and an optional transparency checkerboard restricted to the image bounds.
 *
 * View state (zoom, pan, grid) is persisted in the files store by `surfaceKey` so switching tabs or
 * receiving external disk updates refreshes the image in place without losing the reader's framing.
 */
import { useEffect, useRef, useState } from 'react'
import { Grid2x2, ZoomIn, ZoomOut } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { rememberImageView, savedImageView } from '../../stores/files'
import { Button } from '../ui/button'

const MIN_SCALE = 0.25
const MAX_SCALE = 8

export interface ImageDimensions {
  width: number
  height: number
}

export function FileImagePreview({
  surfaceKey,
  src,
  alt,
  className,
  onDimensions,
  onReload
}: {
  surfaceKey: string
  src: string
  alt: string
  className?: string
  onDimensions: (dimensions: ImageDimensions | null) => void
  onReload: () => void
}) {
  const t = useT()
  const stageRef = useRef<HTMLDivElement>(null)
  const initial = savedImageView(surfaceKey)
  const [scale, setScale] = useState(initial.scale)
  const [tx, setTx] = useState(initial.tx)
  const [ty, setTy] = useState(initial.ty)
  const [grid, setGrid] = useState(initial.grid)
  const [dragging, setDragging] = useState(false)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const failed = failedSrc === src

  useEffect(() => {
    rememberImageView(surfaceKey, { scale, tx, ty, grid })
  }, [surfaceKey, scale, tx, ty, grid])

  useEffect(() => {
    const el = stageRef.current
    if (!el || failed) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const factor = event.ctrlKey
        ? Math.min(1.5, Math.max(1 / 1.5, Math.exp(-event.deltaY * 0.01)))
        : event.deltaY < 0
          ? 1.12
          : 1 / 1.12
      setScale((current) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor))
        if (next <= 1) {
          setTx(0)
          setTy(0)
        }
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [failed])

  const zoom = (next: number) => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
    setScale(clamped)
    if (clamped <= 1) {
      setTx(0)
      setTy(0)
    }
  }

  if (failed) {
    return (
      <div className={cn('flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground', className)}>
        <span className="min-w-0 flex-1">{t('file.imageLoadFailed')}</span>
        <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={onReload}>
          {t('file.reload')}
        </Button>
      </div>
    )
  }

  return (
    <div data-file-image-stage className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden', className)}>
      <div
        ref={stageRef}
        className={cn(
          'flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6 pb-16',
          scale > 1 && (dragging ? 'cursor-grabbing' : 'cursor-grab')
        )}
        onDoubleClick={() => zoom(scale > 1 ? 1 : 2)}
        onPointerDown={(event) => {
          if (event.button !== 0 || scale <= 1) return
          dragRef.current = { x: event.clientX, y: event.clientY, tx, ty }
          setDragging(true)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return
          setTx(dragRef.current.tx + event.clientX - dragRef.current.x)
          setTy(dragRef.current.ty + event.clientY - dragRef.current.y)
        }}
        onPointerUp={() => {
          dragRef.current = null
          setDragging(false)
        }}
        onPointerCancel={() => {
          dragRef.current = null
          setDragging(false)
        }}
      >
        <img
          data-file-image-preview
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            onDimensions(
              naturalWidth > 0 && naturalHeight > 0
                ? { width: naturalWidth, height: naturalHeight }
                : null
            )
          }}
          onError={() => {
            setFailedSrc(src)
            onDimensions(null)
          }}
          className="max-h-full max-w-full min-h-4 min-w-4 object-contain select-none"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            ...(grid
              ? {
                  backgroundImage:
                    'repeating-conic-gradient(color-mix(in srgb, var(--foreground) 7%, transparent) 0% 25%, transparent 0% 50%)',
                  backgroundPosition: '50% 50%',
                  backgroundSize: '16px 16px'
                }
              : undefined)
          }}
        />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <div
          data-file-image-toolbar
          className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-glass-popover-background bg-[image:var(--glass-popover-sheen)] p-1 shadow-glass-popover ring-1 ring-glass-card-border solid:bg-popover solid:bg-none solid:shadow-sm solid:ring-foreground/10"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('common.zoomOut')}
            title={t('common.zoomOut')}
            disabled={scale <= MIN_SCALE}
            onClick={() => zoom(scale / 1.25)}
          >
            <ZoomOut />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="min-w-12 px-2 tabular-nums"
            onClick={() => zoom(1)}
          >
            {Math.round(scale * 100)}%
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('common.zoomIn')}
            title={t('common.zoomIn')}
            disabled={scale >= MAX_SCALE}
            onClick={() => zoom(scale * 1.25)}
          >
            <ZoomIn />
          </Button>
          <span className="mx-0.5 h-3.5 w-px bg-glass-border solid:bg-border" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-file-image-grid-toggle
            aria-label={t('file.toggleGrid')}
            aria-pressed={grid}
            title={t('file.toggleGrid')}
            className={cn(grid ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
            onClick={() => setGrid((current) => !current)}
          >
            <Grid2x2 />
          </Button>
        </div>
      </div>
    </div>
  )
}
