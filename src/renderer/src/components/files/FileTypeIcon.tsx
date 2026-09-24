import { File } from 'lucide-react'
import { fileIconName } from '../../lib/file-icons'
import { cn } from '../../lib/utils'

export function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  const icon = fileIconName(path)
  if (!icon) return <File className={className} aria-hidden />

  return (
    <span
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        maskImage: `url("${new URL(`file-icons/${icon}.svg`, document.baseURI).href}")`,
        maskPosition: 'center',
        maskRepeat: 'no-repeat',
        maskSize: 'contain'
      }}
    />
  )
}
