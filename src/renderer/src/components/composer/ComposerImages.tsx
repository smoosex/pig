import { X } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { Button } from '../ui/button'
import type { PastedImage } from './useComposerImages'

export function ComposerImages({
  images,
  onPreview,
  onRemove,
  disabled = false
}: {
  images: PastedImage[]
  onPreview: (url: string) => void
  onRemove: (id: string) => void
  disabled?: boolean
}) {
  // Hooks stay above the early return: the strip mounts once and images come and go on the same instance.
  const t = useT()
  if (images.length === 0) return null

  return (
    <div className="flex w-full flex-wrap justify-start gap-1.5 px-3.5 pb-1.5">
      {images.map((image) => (
        <div key={image.id} className="relative shrink-0">
          <Button
            type="button"
            variant="ghost"
            className="block h-auto rounded-md p-0 hover:bg-transparent"
            aria-label={t('composer.previewImage')}
            onClick={() => onPreview(image.url)}
          >
            <img src={image.url} alt="" className="h-10 max-w-16 cursor-pointer rounded-md object-cover" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-0.5 right-0.5 size-3.5 rounded-full bg-popover p-0 text-popover-foreground shadow-sm hover:bg-accent hover:text-accent-foreground [&_svg]:size-2"
            aria-label={t('composer.removeImage')}
            disabled={disabled}
            onClick={() => onRemove(image.id)}
          >
            <X />
          </Button>
        </div>
      ))}
    </div>
  )
}
