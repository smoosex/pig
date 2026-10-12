"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

interface TooltipWindowState {
  blurRevision: number
  suppressRestoredFocus: React.RefObject<boolean>
}

const TooltipWindowContext = React.createContext<TooltipWindowState | null>(null)

function TooltipProvider({
  delayDuration = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const suppressRestoredFocus = React.useRef(false)
  const [blurRevision, setBlurRevision] = React.useState(0)

  React.useEffect(() => {
    const handleBlur = () => {
      suppressRestoredFocus.current = true
      setBlurRevision((revision) => revision + 1)
    }
    const releaseSuppression = () => {
      suppressRestoredFocus.current = false
    }
    window.addEventListener("blur", handleBlur)
    window.addEventListener("keydown", releaseSuppression, true)
    window.addEventListener("pointerdown", releaseSuppression, true)
    return () => {
      window.removeEventListener("blur", handleBlur)
      window.removeEventListener("keydown", releaseSuppression, true)
      window.removeEventListener("pointerdown", releaseSuppression, true)
    }
  }, [])

  const windowState = React.useMemo(
    () => ({ blurRevision, suppressRestoredFocus }),
    [blurRevision]
  )

  return (
    <TooltipWindowContext.Provider value={windowState}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        {...props}
      >
        {children}
      </TooltipPrimitive.Provider>
    </TooltipWindowContext.Provider>
  )
}

function Tooltip({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const windowState = React.useContext(TooltipWindowContext)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const open = openProp ?? uncontrolledOpen
  const handledBlurRevision = React.useRef(windowState?.blurRevision ?? 0)
  const changeOpen = React.useCallback((next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }, [onOpenChange, openProp])

  React.useEffect(() => {
    if (!windowState || handledBlurRevision.current === windowState.blurRevision) return
    handledBlurRevision.current = windowState.blurRevision
    if (open) changeOpen(false)
  }, [changeOpen, open, windowState])

  return <TooltipPrimitive.Root data-slot="tooltip" {...props} open={open} onOpenChange={changeOpen} />
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const windowState = React.useContext(TooltipWindowContext)
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onFocus={(event) => {
        onFocus?.(event)
        if (!event.defaultPrevented && windowState?.suppressRestoredFocus.current) {
          event.preventDefault()
        }
      }}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
