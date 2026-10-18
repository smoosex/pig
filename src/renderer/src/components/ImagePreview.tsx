import { useEffect, useRef, useState } from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'
import { useT } from '../hooks/useT'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const MIN = 0.25
const MAX = 8

export function ImagePreview({ src, onClose }: { src: string | null; onClose: () => void }) {
  const t = useT()
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  useEffect(() => {
    setScale(1)
    setTx(0)
    setTy(0)
  }, [src])

  useEffect(() => {
    const el = stageRef.current
    if (!el || !src) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      setScale((current) => {
        const next = Math.min(MAX, Math.max(MIN, current * factor))
        if (next <= 1) {
          setTx(0)
          setTy(0)
        }
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [src])

  const zoom = (next: number) => {
    const clamped = Math.min(MAX, Math.max(MIN, next))
    setScale(clamped)
    if (clamped <= 1) {
      setTx(0)
      setTy(0)
    }
  }

  return (
    <Dialog
      open={src !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        showCloseButton
        className="flex h-[85vh] w-[min(96vw,80rem)] max-w-[min(96vw,80rem)] flex-col items-center gap-3 border-0 bg-transparent bg-none p-0 shadow-none ring-0 solid:bg-transparent solid:shadow-none solid:ring-0 sm:max-w-[min(96vw,80rem)]"
      >
        <DialogTitle className="sr-only">{t('composer.imagePreview')}</DialogTitle>
        {src ? (
          <div
            ref={stageRef}
            className="min-h-0 w-full flex-1 overflow-hidden"
            onPointerDown={(event) => {
              if (scale <= 1) return
              drag.current = { x: event.clientX, y: event.clientY, tx, ty }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (!drag.current) return
              setTx(drag.current.tx + event.clientX - drag.current.x)
              setTy(drag.current.ty + event.clientY - drag.current.y)
            }}
            onPointerUp={() => {
              drag.current = null
            }}
            onPointerCancel={() => {
              drag.current = null
            }}
          >
            <img
              src={src}
              alt=""
              draggable={false}
              className="size-full object-contain select-none"
              style={{
                transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                cursor: scale > 1 ? 'grab' : 'default'
              }}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-0.5 rounded-full bg-popover/90 p-1 ring-1 ring-foreground/10">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.zoomOut')}
            onClick={() => zoom(scale / 1.25)}
          >
            <ZoomOut />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-12 px-2 tabular-nums"
            onClick={() => zoom(1)}
          >
            {Math.round(scale * 100)}%
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.zoomIn')}
            onClick={() => zoom(scale * 1.25)}
          >
            <ZoomIn />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
