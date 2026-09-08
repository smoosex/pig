import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

const MotionViewport = motion.create(ScrollAreaPrimitive.Viewport)

function ScrollArea({
  className,
  children,
  layoutScroll = false,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { layoutScroll?: boolean }) {
  const Viewport = layoutScroll ? MotionViewport : ScrollAreaPrimitive.Viewport

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <Viewport
        {...(layoutScroll ? { layoutScroll: true } : {})}
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 [&>div]:!block [&>div]:!min-w-0 [&>div]:w-full"
      >
        {children}
      </Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
