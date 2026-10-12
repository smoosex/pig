"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

const CORNER = 6;
const DASH = "2 2";
// The row pitch (30px) does not divide the dash period (4px), so a path that starts
// its own dash at its own top lands a dash right next to the previous one just before
// every other corner. Every path here measures its dash from the top of the list, so
// consecutive rows read as one unbroken spine instead of two strokes meeting.
const phaseAt = (y: number) => ((y % 4) + 4) % 4;

export type HookSidebarItem = string | { label: string; href?: string };

export type HookSidebarItemContext = {
  index: number;
  label: string;
  active: boolean;
};

export type HookSidebarProps = Omit<ComponentProps<"nav">, "onChange"> & {
  items: HookSidebarItem[];
  label?: string;
  value?: number;
  defaultValue?: number;
  onChange?: (index: number) => void;
  renderItem?: (
    item: HookSidebarItem,
    index: number,
    context: HookSidebarItemContext,
  ) => ReactNode;
  color?: string;
  dashed?: boolean;
  railLeft?: string;
};

const hrefOf = (item: HookSidebarItem) =>
  typeof item === "string" ? undefined : item.href;

const labelOf = (item: HookSidebarItem) =>
  typeof item === "string" ? item : item.label;

// One row owns one path: it runs down from where the row above bent away, bends at
// its own centre and stops at the label. Rows never overlap each other, so a muted
// row and an accented one cannot show through one another.
const TreeLine = ({
  dashed,
  startY,
  rise,
  accented,
  color,
  left,
}: {
  dashed: boolean;
  /** Height in the list where this run leaves the corner above. */
  startY: number;
  /** Length of the run above this row's bend. */
  rise: number;
  accented: boolean;
  color: string;
  left?: string;
}) => (
  <svg
    aria-hidden
    width="12"
    height={rise + 7}
    fill="none"
    className={cn(
      "pointer-events-none absolute transition-colors duration-150 motion-reduce:transition-none",
      !accented && "text-foreground/30",
    )}
    style={{ left, bottom: "calc(50% - 1px)", color: accented ? color : undefined }}
  >
    <path
      d={`M0.5 0V${rise}a6 6 0 0 0 6 6H12`}
      stroke="currentColor"
      strokeWidth="1"
      strokeDasharray={dashed ? DASH : undefined}
      strokeDashoffset={dashed ? phaseAt(startY) : undefined}
    />
  </svg>
);

export function HookSidebar({
  items,
  label,
  value,
  defaultValue = 0,
  onChange,
  renderItem,
  color = "var(--primary)",
  dashed = true,
  railLeft = "0.125rem",
  className,
  ...props
}: HookSidebarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const [centers, setCenters] = useState<number[]>([]);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);

  const activeIndex = value ?? internalValue;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const measure = () =>
      setCenters(
        itemRefs.current.map((el) =>
          el ? el.offsetTop + el.offsetHeight / 2 : 0,
        ),
      );

    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [items.length]);

  // The accent covers the path down to the current row and, while the pointer is in
  // the list, also down to the row under it when that one sits further down.
  const hovered = pointerInside || focusInside ? hoverIndex : null;
  const accentTo =
    hovered !== null && hovered > activeIndex ? hovered : activeIndex;

  const select = (index: number) => {
    if (value === undefined) setInternalValue(index);
    onChange?.(index);
  };

  return (
    <nav
      data-slot="hook-sidebar"
      aria-label={label}
      className={cn("flex flex-col", className)}
      {...props}
    >
      {label && (
        <span
          data-slot="hook-sidebar-label"
          className="pb-3 pl-0.5 pr-2 font-sans text-sm font-medium uppercase tracking-wide text-foreground"
        >
          {label}
        </span>
      )}

      <div
        ref={listRef}
        onMouseLeave={() => setPointerInside(false)}
        className="relative flex flex-col gap-0.5"
      >
        {items.map((item, index) => {
          const text = labelOf(item);
          const href = hrefOf(item);
          const isActive = index === activeIndex;
          // Runs meet apex to apex: this row starts where the row above stopped
          // bending, and its own bend sits on the row's centre line.
          const startY = index === 0 ? 0 : (centers[index - 1] ?? 0) - CORNER;
          const rise = Math.max(0, (centers[index] ?? 0) - CORNER - startY);
          const line = (
            <TreeLine
              dashed={dashed}
              startY={startY}
              rise={rise}
              accented={index <= accentTo}
              color={color}
              left={railLeft}
            />
          );
          const setRef = (el: HTMLElement | null) => {
            itemRefs.current[index] = el;
          };
          const interactionProps = {
            onMouseEnter: () => {
              setHoverIndex(index);
              setPointerInside(true);
            },
            onFocus: () => {
              setHoverIndex(index);
              setFocusInside(true);
            },
            onBlur: () => setFocusInside(false),
          };
          const rowProps = {
            "data-slot": "hook-sidebar-item",
            "data-active": isActive,
            ...interactionProps,
            onClick: () => select(index),
            className: cn(
              "relative rounded-lg py-1.5 pl-5 pr-2 text-left text-sm transition-colors duration-200 motion-reduce:transition-none",
              isActive
                ? "text-foreground"
                : "text-foreground/50 hover:text-foreground/80",
            ),
          };

          if (renderItem) {
            return (
              <div
                key={`${index}-${text}`}
                ref={setRef}
                data-slot="hook-sidebar-item"
                data-active={isActive}
                {...interactionProps}
                className="relative min-w-0"
              >
                {renderItem(item, index, {
                  index,
                  label: text,
                  active: isActive,
                })}
                {line}
              </div>
            );
          }

          return href ? (
            <a
              key={`${index}-${text}`}
              {...rowProps}
              ref={setRef}
              href={href}
              aria-current={isActive ? "page" : undefined}
            >
              {line}
              {text}
            </a>
          ) : (
            <button
              key={`${index}-${text}`}
              {...rowProps}
              ref={setRef}
              type="button"
              aria-current={isActive ? "true" : undefined}
            >
              {line}
              {text}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
