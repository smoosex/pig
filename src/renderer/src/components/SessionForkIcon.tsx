import { CornerDownRight } from 'lucide-react'

/** Marks a session as a fork; its parent's row sits above it in the same list. */
export function SessionForkIcon({ title }: { title?: string }) {
  const icon = <CornerDownRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
  return title ? <span title={title}>{icon}</span> : icon
}
