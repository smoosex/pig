import { cn } from '../lib/utils'
import { Empty } from './ui/empty'

export function SessionGreeting({ className }: { className?: string }) {
  return (
    <Empty className={cn('min-h-0 flex-1 gap-6', className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 800 800"
        aria-hidden="true"
        className="size-12 text-primary"
      >
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
        />
        <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
      </svg>
      <p className="max-w-xl font-wenkai text-xl text-foreground">
        昨天是段历史，明天是个谜团，而今天是天赐的礼物
      </p>
    </Empty>
  )
}
