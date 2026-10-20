import { useState, type ReactElement } from 'react'
import { Check, Copy } from 'lucide-react'
import { formatPastedTextSize } from '../../../shared/pasted-text'
import { useT } from '../hooks/useT'
import { Button } from './ui/button'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from './ui/popover'

export function PastedTextPreview({
  text,
  byteSize,
  title,
  children
}: {
  text: string
  byteSize: number
  title?: string
  children: ReactElement
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setCopied(false)
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        sticky="always"
        className="max-h-[min(32rem,var(--radix-popover-content-available-height,32rem))] w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-xl p-3"
      >
        <PopoverHeader className="flex-row items-center justify-between gap-3">
          <PopoverTitle className="text-sm">{title ?? t('composer.pastedText')}</PopoverTitle>
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-xs text-muted-foreground">
              UTF-8 {formatPastedTextSize(byteSize)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={copied ? t('common.copied') : t('common.copyAll')}
              title={copied ? t('common.copied') : t('common.copyAll')}
              onClick={() => void copy()}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
        </PopoverHeader>
        <p className="line-clamp-3 max-h-15 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {text}
        </p>
        <pre className="min-h-0 max-h-[max(0px,min(20rem,calc(var(--radix-popover-content-available-height,32rem)-10rem)))] overflow-auto rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs leading-snug whitespace-pre-wrap break-words [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {text}
        </pre>
      </PopoverContent>
    </Popover>
  )
}
