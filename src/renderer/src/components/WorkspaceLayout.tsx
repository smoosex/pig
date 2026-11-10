/** Settings replace workspace content immediately; only shared sidebar widths animate. */
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/utils'

export function WorkspaceLayout({
  settingsOpen, leftCollapsed, rightCollapsed, leftFloating, rightFloating,
  left, right, renderSettings, children
}: {
  settingsOpen: boolean
  leftCollapsed: boolean
  rightCollapsed: boolean
  leftFloating: boolean
  rightFloating: boolean
  left: ReactNode
  right: ReactNode
  renderSettings: (navigationTarget: HTMLElement | null, active: boolean) => ReactNode
  children: ReactNode
}) {
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null)

  return (
    <>
      <div
        data-workspace-left-rail
        className={cn('relative shrink-0 transition-[width] duration-200 ease-in-out motion-reduce:transition-none',
          settingsOpen || !leftCollapsed ? 'w-62' : 'w-0',
          leftFloating && !settingsOpen ? 'overflow-visible' : 'overflow-hidden')}
      >
        <div
          inert={settingsOpen}
          aria-hidden={settingsOpen}
          className={cn('absolute inset-y-0 left-0 w-62', settingsOpen ? 'hidden' : 'flex')}
        >
          {left}
        </div>
        <div
          ref={setNavigationTarget}
          data-settings-navigation
          inert={!settingsOpen}
          aria-hidden={!settingsOpen}
          className={cn('absolute inset-y-0 left-0 w-62', settingsOpen ? 'flex' : 'hidden')}
        />
      </div>
      <div data-workspace-center className="relative flex min-h-0 min-w-0 flex-1">
        {settingsOpen ? renderSettings(navigationTarget, true) : children}
      </div>
      <div
        data-workspace-right-rail
        inert={settingsOpen}
        aria-hidden={settingsOpen}
        className={cn('relative flex shrink-0 transition-[width] duration-200 ease-in-out motion-reduce:transition-none',
          !settingsOpen && !rightCollapsed ? 'w-62' : 'w-0',
          rightFloating && !settingsOpen ? 'overflow-visible' : 'overflow-hidden',
          settingsOpen && 'pointer-events-none')}
      >
        {right}
      </div>
    </>
  )
}
