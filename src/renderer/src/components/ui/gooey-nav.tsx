import {
  useEffect,
  useId,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode
} from 'react'
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react'
import { cn } from '@/lib/utils'

const SPRING = { type: 'spring', stiffness: 200, damping: 28, mass: 1 } as const
const NECK_BREAK = 0.22
const NECK_H = 100
const FADE_IN = 'transition-colors duration-[400ms]'
const FADE_OUT = 'transition-colors duration-0'
const BAR = 'bg-[var(--gooey-nav-background)] text-[color:var(--gooey-nav-background)]'
const SIZES = {
  xs: {
    label: 'gap-1 px-2 py-1.5 text-[11px] leading-4 [&_svg]:size-[11px]',
    radius: 8,
    separation: 14
  },
  sm: {
    label: 'gap-1.5 px-3.5 py-2 text-xs leading-4 [&_svg]:size-3',
    radius: 10,
    separation: 16
  },
  md: {
    label: 'gap-2 px-5 py-2.5 text-sm leading-5 [&_svg]:size-3.5',
    radius: 12,
    separation: 20
  },
  lg: {
    label: 'gap-2.5 px-6 py-3 text-base leading-6 [&_svg]:size-4',
    radius: 14,
    separation: 24
  }
} as const

export type GooeyNavSize = keyof typeof SIZES

type NavItem = { label: string; href?: string; icon?: ReactNode; disabled?: boolean }

export type GooeyNavItem = string | NavItem

const toItem = (item: GooeyNavItem): NavItem =>
  typeof item === 'string' ? { label: item } : item

export type GooeyNavProps = Omit<ComponentProps<'nav'>, 'onChange'> & {
  items: GooeyNavItem[]
  value?: number
  defaultValue?: number
  onChange?: (index: number) => void
  size?: GooeyNavSize
  activeColor?: string
  activeLabelColor?: string
  separation?: number
  radius?: number
}

function neckPath(gap: number, span: number) {
  if (!Number.isFinite(gap) || !Number.isFinite(span) || gap <= 0 || span <= 0) {
    return ''
  }
  const waist = NECK_H * (1 - gap / (span * NECK_BREAK))
  if (waist <= 0) return ''
  const start = span - gap
  const mid = start + gap / 2
  return `M${start} 0 Q${mid} ${NECK_H - waist} ${span} 0 L${span} ${NECK_H} Q${mid} ${waist} ${start} ${NECK_H} Z`
}

type SegmentProps = {
  gap: number
  span: number
  hasSeam: boolean
  leftFill: string
  rightFill: string
  reduced: boolean
  radii: Record<string, number>
  className?: string
  style?: CSSProperties
  children: ReactNode
}

function Segment({
  gap,
  span,
  hasSeam,
  leftFill,
  rightFill,
  reduced,
  radii,
  className,
  style,
  children
}: SegmentProps) {
  const marginLeft = useSpring(gap, SPRING)
  const gradientId = `gooey-neck-${useId().replace(/:/g, '')}`

  useEffect(() => {
    if (reduced) marginLeft.jump(gap)
    else marginLeft.set(gap)
  }, [gap, marginLeft, reduced])

  const d = useTransform(marginLeft, (g) => neckPath(g, span))

  return (
    <motion.li
      data-slot="gooey-nav-segment"
      className={cn('relative', className)}
      style={{ ...style, marginLeft }}
      initial={false}
      animate={radii}
      transition={reduced ? { duration: 0 } : SPRING}
    >
      {hasSeam && (
        <svg
          aria-hidden
          width={span}
          viewBox={`0 0 ${span} ${NECK_H}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute top-0 right-full h-full"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1">
              <stop offset="0" stopColor={leftFill} />
              <stop offset="1" stopColor={rightFill} />
            </linearGradient>
          </defs>
          <motion.path d={d} fill={`url(#${gradientId})`} />
        </svg>
      )}
      {children}
    </motion.li>
  )
}

type NavLabelProps = NavItem & {
  isActive: boolean
  size: GooeyNavSize
  activeLabelColor: string
  onSelect: () => void
}

function NavLabel({
  label,
  href,
  icon,
  disabled,
  isActive,
  size,
  activeLabelColor,
  onSelect
}: NavLabelProps) {
  const props = {
    'data-slot': 'gooey-nav-item',
    'data-active': isActive,
    'aria-current': isActive ? (href ? 'page' : true) : undefined,
    className: cn(
      'flex cursor-pointer items-center whitespace-nowrap font-medium disabled:cursor-default disabled:opacity-50 [&_svg]:shrink-0',
      isActive ? FADE_IN : FADE_OUT,
      SIZES[size].label,
      !isActive && 'text-glass-prompt-foreground/70 hover:text-glass-prompt-foreground solid:text-muted-foreground solid:hover:text-foreground'
    ),
    style: isActive ? { color: activeLabelColor } : undefined,
    onClick: onSelect
  } as const

  return href ? (
    <a href={href} {...props}>
      {icon}
      {label}
    </a>
  ) : (
    <button type="button" disabled={disabled} {...props}>
      {icon}
      {label}
    </button>
  )
}

export function GooeyNav({
  items,
  value,
  defaultValue = 0,
  onChange,
  size = 'md',
  activeColor = 'var(--gooey-nav-active-background)',
  activeLabelColor = 'var(--gooey-nav-active-foreground)',
  separation,
  radius,
  className,
  ...props
}: GooeyNavProps) {
  const reduced = useReducedMotion() ?? false
  const [uncontrolled, setUncontrolled] = useState(defaultValue)
  const active = value ?? uncontrolled
  const span = separation ?? SIZES[size].separation
  const corner = radius ?? SIZES[size].radius

  const open = (seam: number) =>
    seam === 0 || seam === items.length || seam - 1 === active || seam === active

  const fill = (i: number) => (i === active ? activeColor : 'currentColor')

  return (
    <nav data-slot="gooey-nav" className={cn('glass-gooey-nav inline-block', className)} {...props}>
      <ul className="flex items-center">
        {items.map((item, i) => {
          const navItem = toItem(item)
          const isActive = i === active

          return (
            <Segment
              key={`${i}-${navItem.label}`}
              gap={i === 0 || !open(i) ? 0 : span}
              span={span}
              hasSeam={i > 0}
              leftFill={fill(i - 1)}
              rightFill={fill(i)}
              reduced={reduced}
              radii={{
                borderTopLeftRadius: open(i) ? corner : 0,
                borderBottomLeftRadius: open(i) ? corner : 0,
                borderTopRightRadius: open(i + 1) ? corner : 0,
                borderBottomRightRadius: open(i + 1) ? corner : 0
              }}
              className={cn(BAR, isActive ? FADE_IN : FADE_OUT, isActive && 'bg-(image:--glass-badge-sheen) shadow-glass-badge solid:bg-none solid:shadow-none')}
              style={{ backgroundColor: isActive ? activeColor : undefined }}
            >
              <NavLabel
                {...navItem}
                isActive={isActive}
                size={size}
                activeLabelColor={activeLabelColor}
                onSelect={() => {
                  if (value === undefined) setUncontrolled(i)
                  onChange?.(i)
                }}
              />
            </Segment>
          )
        })}
      </ul>
    </nav>
  )
}
