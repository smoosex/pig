import type { ReactNode } from 'react'

export function SettingsRow({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-6 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10 [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border/50 [&>*+*]:before:content-['']">
      {children}
    </div>
  )
}
