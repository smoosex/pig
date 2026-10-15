/** Material changes only surfaces and tints; both styles share hover motion and stable selection. */
const transition = 'transition-colors duration-100 ease-out motion-reduce:transition-none'

export const sidebarSurfaceHover = `${transition} hover:bg-sidebar-foreground/6! solid:hover:bg-sidebar-accent!`

/**
 * Rows own every button background, including hover/expanded and hold-to-confirm idle/confirmed.
 * Foregrounds remain caller-owned; hold feedback uses its progress ring and red/green icon,
 * deliberately without a confirmed-state fill.
 */
export const sidebarButtonSurface = '!bg-transparent'

const selectedSurface = `${transition} bg-sidebar-foreground/12 hover:bg-sidebar-foreground/12! solid:bg-sidebar-accent solid:hover:bg-sidebar-accent!`

export function sidebarRowSurface(selected: boolean): string {
  return selected ? selectedSurface : `${transition} hover:bg-transparent!`
}

export const sidebarSurfaceToggle = `${sidebarSurfaceHover} data-[state=on]:bg-sidebar-foreground/12 data-[state=on]:hover:bg-sidebar-foreground/12! aria-pressed:bg-sidebar-foreground/12 aria-pressed:hover:bg-sidebar-foreground/12! solid:data-[state=on]:bg-sidebar-accent solid:data-[state=on]:hover:bg-sidebar-accent! solid:aria-pressed:bg-sidebar-accent solid:aria-pressed:hover:bg-sidebar-accent!`
