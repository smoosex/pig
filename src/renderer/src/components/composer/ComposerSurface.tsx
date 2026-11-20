import { useState, type ComponentProps, type ReactNode } from 'react'
import { BorderBeam } from '@smoose/border-beam'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../stores/settings'
import { InputGroup, InputGroupAddon } from '../ui/input-group'
import { useComposerAppearance } from './useComposerAppearance'

export const composerTextLayout = 'min-h-16 w-full shrink-0 px-3.5 pt-3 text-sm leading-snug'

/** Shared visual frame; each composer provides its own editor, controls and submission logic. */
export function ComposerSurface({
  before, toolbar, children, visible = true, streaming, bashMode = false, className, ...props
}: ComponentProps<'div'> & {
  before?: ReactNode
  toolbar: ReactNode
  visible?: boolean
  streaming: boolean
  bashMode?: boolean
}) {
  const appearance = useComposerAppearance()
  const beamEnabled = useSettingsStore((s) => s.beamBorderEnabled)
  const [focused, setFocused] = useState(false)
  return (
    <div {...props} className={cn('relative rounded-2xl shadow-glass-card solid:shadow-md', className)}>
      {before}
      <div className="relative z-10">
        <BorderBeam size={bashMode ? 'pulse-inner' : 'md'} {...appearance} active={visible && beamEnabled && (bashMode || focused || streaming)} className="w-full">
          <InputGroup
            className="@container/composer min-h-[min(8rem,calc(100dvh-6rem))] max-h-[min(16rem,calc(100dvh-6rem))] overflow-hidden rounded-2xl solid:bg-composer-input-background text-glass-prompt-foreground solid:text-foreground has-disabled:opacity-100 transition-[background-color,border-color] duration-200 ease-in-out motion-reduce:transition-none"
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
              setFocused(false)
            }}
          >
            <div className="min-h-0 w-full flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {children}
            </div>
            {toolbar}
          </InputGroup>
        </BorderBeam>
      </div>
    </div>
  )
}

export function ComposerControls({ leading, trailing }: { leading: ReactNode; trailing: ReactNode }) {
  return (
    <InputGroupAddon align="block-end" className="shrink-0 justify-between px-2.5 pb-2.5">
      <div className="@container/composer-tools flex min-w-0 flex-1 items-center gap-1">{leading}</div>
      <div className="flex items-center gap-1.5">{trailing}</div>
    </InputGroupAddon>
  )
}
