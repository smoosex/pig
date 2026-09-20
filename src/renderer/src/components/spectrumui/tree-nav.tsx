'use client';

import * as React from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';

import { cn } from '@/lib/utils';

export interface TreeNavItem {
  label: string;
  href: string;
  /** Small pill after the label, e.g. "New". */
  badge?: string;
  /** Opens in a new tab. */
  external?: boolean;
}

type LinkComponent =
  'a' | React.ComponentType<React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

export interface TreeNavProps {
  items: TreeNavItem[];
  /** href of the current page; the marker and background rest on this row. */
  activeHref?: string;
  /** Slide the marker and background to the hovered row and spring back on leave. */
  followHover?: boolean;
  showHighlight?: boolean;
  /** Element used for links, e.g. Next's Link. Defaults to a plain anchor. */
  linkComponent?: LinkComponent;
  onSelect?: (item: TreeNavItem, event: React.MouseEvent<HTMLAnchorElement>) => void;
  renderItem?: (item: TreeNavItem, index: number, isActive: boolean) => React.ReactNode;
  className?: string;
}

const ROW_H = 32;
const MARKER = 7;
/** Horizontal centre of the rail inside the 24px gutter. */
const RAIL_X = 10;

// Critically damped (no overshoot) with a ~0.3s response: Apple's default for
// repositioning UI, tightened a little for a hover highlight. Springs re-target from the live value and carry velocity,
// so sweeping the pointer down the list never stutters or snaps.
const GLIDE = { type: 'spring', visualDuration: 0.22, bounce: 0 } as const;
const FADE = { duration: 0.12, ease: 'easeOut' } as const;

export function TreeNav({
  items,
  activeHref,
  followHover = true,
  showHighlight = true,
  linkComponent: Link = 'a',
  onSelect,
  renderItem,
  className,
}: TreeNavProps) {
  const listRef = React.useRef<HTMLUListElement>(null);
  const rowRefs = React.useRef<(HTMLLIElement | null)[]>([]);
  const centersRef = React.useRef<number[]>([]);
  const hoveredRef = React.useRef<number | null>(null);
  const reduced = useReducedMotion() ?? false;
  const activeIndex = items.findIndex((item) => item.href === activeHref);
  // Handlers and the measurer read these through refs so they never go stale
  // and never need to be re-created; the sync runs before the measure effect.
  const reducedRef = React.useRef(reduced);
  const activeRef = React.useRef(activeIndex);
  React.useLayoutEffect(() => {
    reducedRef.current = reduced;
    activeRef.current = activeIndex;
  });

  // Rail length is the only measurement that renders; everything that moves is
  // a motion value, so hovering never re-renders the list.
  const [end, setEnd] = React.useState(0);
  const [measured, setMeasured] = React.useState(false);

  const centerY = useMotionValue(0);
  const visibility = useMotionValue(0);
  const pillY = useTransform(centerY, (v) => v - ROW_H / 2);
  const markerY = useTransform(centerY, (v) => v - MARKER / 2);
  const accentScale = useTransform(centerY, (v) => (end > 0 ? Math.min(1, v / end) : 0));

  const moveTo = React.useCallback(
    (index: number | null, immediate = false) => {
      const centers = centersRef.current;
      if (index === null || index < 0 || index >= centers.length) {
        animate(visibility, 0, FADE);
        return;
      }
      const target = centers[index];
      // Coming back from hidden: appear on the row instead of travelling from
      // wherever the marker was last parked.
      const jump = immediate || reducedRef.current || visibility.get() < 0.05;
      if (jump) centerY.jump(target);
      else animate(centerY, target, GLIDE);
      animate(visibility, 1, FADE);
    },
    [centerY, visibility],
  );

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const next = rowRefs.current
        .slice(0, items.length)
        .map((el) => (el ? el.offsetTop + ROW_H / 2 : 0));
      centersRef.current = next;
      setEnd(next.length > 0 ? next[next.length - 1] : 0);
      setMeasured(true);
      // A re-measure is a layout change, not motion: settle instantly.
      moveTo(hoveredRef.current ?? activeRef.current, true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [items.length, moveTo]);

  // Route changes glide; a hover in progress keeps priority.
  React.useEffect(() => {
    if (hoveredRef.current === null) moveTo(activeIndex);
  }, [activeIndex, moveTo]);

  const enter = (index: number) => {
    if (!followHover) return;
    hoveredRef.current = index;
    moveTo(index);
  };
  const leave = () => {
    if (!followHover) return;
    hoveredRef.current = null;
    moveTo(activeRef.current);
  };

  return (
    <ul
      ref={listRef}
      className={cn('relative flex flex-col gap-0.5 ps-6', className)}
      onPointerLeave={leave}
    >
      {/* Tree rail with a dot terminal, an accent run that grows to the marked
          row, and the diamond marker. All motion is transform + opacity. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 start-0 w-5">
        <span
          className="absolute top-0 w-px bg-border"
          style={{ insetInlineStart: RAIL_X - 0.5, height: end }}
        />
        <span
          className="absolute size-1 rounded-full bg-border"
          style={{ insetInlineStart: RAIL_X - 2, top: end - 2 }}
        />
        <motion.span
          className="absolute top-0 w-px origin-top bg-primary will-change-transform"
          style={{
            insetInlineStart: RAIL_X - 0.5,
            height: end,
            scaleY: accentScale,
            opacity: visibility,
          }}
        />
        <motion.span
          className="absolute top-0 rounded-xs bg-primary will-change-transform"
          style={{
            insetInlineStart: RAIL_X - MARKER / 2,
            width: MARKER,
            height: MARKER,
            y: markerY,
            rotate: 45,
            opacity: visibility,
          }}
        />
      </span>

      {/* One shared background: rests on the active row, follows the pointer,
          springs back on leave. */}
      {showHighlight ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute end-0 start-6 top-0 rounded-md bg-sidebar-accent will-change-transform"
          style={{ height: ROW_H, y: pillY, opacity: visibility }}
        />
      ) : null}

      {items.map((item, index) => {
        const isActive = index === activeIndex;
        return (
          <li
            key={item.href}
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            className="relative"
            onPointerEnter={() => enter(index)}
            onFocusCapture={() => enter(index)}
            onBlurCapture={leave}
          >
            {renderItem ? (
              renderItem(item, index, isActive)
            ) : (
              <Link
                href={item.href}
                target={item.external ? '_blank' : undefined}
                rel={item.external ? 'noreferrer' : undefined}
                aria-current={isActive ? 'page' : undefined}
                onClick={onSelect ? (event) => onSelect(item, event) : undefined}
                onFocus={() => enter(index)}
                onBlur={leave}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-3 text-[13px] leading-5 antialiased transition-colors duration-150 ease-out',
                  isActive && !measured && 'bg-sidebar-accent',
                  isActive
                    ? 'font-medium text-sidebar-accent-foreground'
                    : 'font-normal text-muted-foreground hover:text-sidebar-foreground',
                )}
              >
                <span className="truncate">{item.label}</span>
                {item.badge && (
                  <span className="inline-flex h-4.5 shrink-0 items-center rounded-md bg-secondary px-1.25 text-xs font-medium leading-none text-secondary-foreground">
                    {item.badge}
                  </span>
                )}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
