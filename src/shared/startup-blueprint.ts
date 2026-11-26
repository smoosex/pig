/**
 * Compact, privacy-free geometry blueprint of the last settled workspace layout.
 *
 * Stored in `.pig/startup-blueprint.json` and read synchronously when the startup screen opens so
 * every frosted placeholder shape sits at the exact pixel coordinates of the real UI element that
 * will sharpen out of blur beneath it, adapting cleanly across window resizes via region anchors.
 */

/** 0 = top header, 1 = left sidebar, 2 = center content card, 3 = right workspace panel. */
export type StartupBlueprintRegion = 0 | 1 | 2 | 3

export type StartupBlueprintKind = 'capsule' | 'pill' | 'bar' | 'ghost' | 'orb'

export type StartupBlueprintAnchor =
  | 'tl'  // (dx from region left, dy from region top, w, h)
  | 'tr'  // (dx from region right, dy from region top, w, h)
  | 'tc'  // (dx from region centerX, dy from region top, w, h)
  | 'bl'  // (dx from region left, dy from region bottom, w, h)
  | 'br'  // (dx from region right, dy from region bottom, w, h)
  | 'cc'  // (dx from region centerX, ny 0..1 of regionH, w, h)
  | 'cb'  // (dx from region centerX, dy from region bottom, w, h)
  | 'box' // (nx, ny, nw, nh 0..1 of regionW / regionH)

export interface StartupBlueprintItem {
  region: StartupBlueprintRegion
  kind: StartupBlueprintKind
  anchor: StartupBlueprintAnchor
  a: number
  b: number
  w: number
  h: number
  r: number
}

export interface StartupBlueprint {
  version: 1
  leftOpen: boolean
  rightOpen: boolean
  /** Width of the center content card when captured, for max-width column scaling on resize. */
  refCardW: number
  items: StartupBlueprintItem[]
}

export interface BlueprintBox {
  x: number
  y: number
  w: number
  h: number
}

const VALID_KINDS = new Set<StartupBlueprintKind>(['capsule', 'pill', 'bar', 'ghost', 'orb'])
const VALID_ANCHORS = new Set<StartupBlueprintAnchor>(['tl', 'tr', 'tc', 'bl', 'br', 'cc', 'cb', 'box'])
const MAX_BLUEPRINT_ITEMS = 96

const round1 = (v: number) => Math.round(v * 10) / 10
const round4 = (v: number) => Math.round(v * 10000) / 10000

export function workspaceRegionBox(
  region: StartupBlueprintRegion,
  winW: number,
  winH: number,
  leftOpen: boolean,
  rightOpen: boolean
): BlueprintBox {
  const headerH = 40
  const leftW = leftOpen && winW >= 648 ? 248 : 0
  const rightW = rightOpen && winW >= (leftW > 0 ? 896 : 648) ? 248 : 0
  if (region === 0) return { x: 0, y: 0, w: winW, h: headerH }
  if (region === 1) return { x: 0, y: headerH, w: leftW, h: Math.max(0, winH - headerH) }
  if (region === 3) return { x: winW - rightW, y: headerH, w: rightW, h: Math.max(0, winH - headerH) }
  return {
    x: leftW + 8,
    y: headerH + 8,
    w: Math.max(200, winW - leftW - rightW - 16),
    h: Math.max(120, winH - headerH - 16)
  }
}

export function encodeBlueprintItem(
  rect: BlueprintBox,
  box: BlueprintBox,
  region: StartupBlueprintRegion,
  kind: StartupBlueprintKind,
  anchor: StartupBlueprintAnchor,
  radius: number
): StartupBlueprintItem {
  const bw = Math.max(1, box.w)
  const bh = Math.max(1, box.h)
  const r = round1(Math.max(0, radius))
  switch (anchor) {
    case 'tl':
      return { region, kind, anchor, a: round1(rect.x - box.x), b: round1(rect.y - box.y), w: round1(rect.w), h: round1(rect.h), r }
    case 'tr':
      return { region, kind, anchor, a: round1((box.x + bw) - (rect.x + rect.w)), b: round1(rect.y - box.y), w: round1(rect.w), h: round1(rect.h), r }
    case 'tc':
      return { region, kind, anchor, a: round1((rect.x + rect.w * 0.5) - (box.x + bw * 0.5)), b: round1(rect.y - box.y), w: round1(rect.w), h: round1(rect.h), r }
    case 'bl':
      return { region, kind, anchor, a: round1(rect.x - box.x), b: round1((box.y + bh) - (rect.y + rect.h)), w: round1(rect.w), h: round1(rect.h), r }
    case 'br':
      return { region, kind, anchor, a: round1((box.x + bw) - (rect.x + rect.w)), b: round1((box.y + bh) - (rect.y + rect.h)), w: round1(rect.w), h: round1(rect.h), r }
    case 'cc':
      return {
        region,
        kind,
        anchor,
        a: round1((rect.x + rect.w * 0.5) - (box.x + bw * 0.5)),
        b: round4(((rect.y + rect.h * 0.5) - box.y) / bh),
        w: round1(rect.w),
        h: round1(rect.h),
        r
      }
    case 'cb':
      return {
        region,
        kind,
        anchor,
        a: round1((rect.x + rect.w * 0.5) - (box.x + bw * 0.5)),
        b: round1((box.y + bh) - (rect.y + rect.h)),
        w: round1(rect.w),
        h: round1(rect.h),
        r
      }
    case 'box':
      return {
        region,
        kind,
        anchor,
        a: round4((rect.x - box.x) / bw),
        b: round4((rect.y - box.y) / bh),
        w: round4(rect.w / bw),
        h: round4(rect.h / bh),
        r
      }
  }
}

function projectColumnHorizontal(
  item: StartupBlueprintItem,
  boxX: number,
  bw: number,
  refCardW: number
): { x: number; w: number } {
  const refColW = Math.max(120, Math.min(832, refCardW) - 64)
  const curColW = Math.max(120, Math.min(832, bw) - 64)
  if (item.w >= refColW * 0.85) {
    const scale = curColW / refColW
    const w = item.w * scale
    return { x: boxX + bw * 0.5 + item.a * scale - w * 0.5, w }
  }
  const w = Math.min(item.w, curColW)
  const edgeDelta = (curColW - refColW) * 0.5
  const centerOffset = item.a < -refColW * 0.15
    ? item.a - edgeDelta
    : item.a > refColW * 0.15
      ? item.a + edgeDelta
      : item.a
  return { x: boxX + bw * 0.5 + centerOffset - w * 0.5, w }
}

export function projectBlueprintItem(
  item: StartupBlueprintItem,
  box: BlueprintBox,
  refCardW: number
): BlueprintBox {
  const bw = Math.max(1, box.w)
  const bh = Math.max(1, box.h)
  switch (item.anchor) {
    case 'tl':
      return { x: box.x + item.a, y: box.y + item.b, w: Math.min(item.w, Math.max(0, bw - item.a - 4)), h: item.h }
    case 'tr':
      return { x: box.x + bw - item.a - item.w, y: box.y + item.b, w: item.w, h: item.h }
    case 'tc': {
      const avail = item.region === 0 ? Math.max(80, bw - 512) : Math.max(80, bw - 32)
      const scale = item.w > avail ? avail / Math.max(1, item.w) : 1
      const w = item.w * scale
      return { x: box.x + bw * 0.5 + item.a * scale - w * 0.5, y: box.y + item.b, w, h: item.h }
    }
    case 'bl':
      return { x: box.x + item.a, y: box.y + bh - item.b - item.h, w: Math.min(item.w, Math.max(0, bw - item.a - 4)), h: item.h }
    case 'br':
      return { x: box.x + bw - item.a - item.w, y: box.y + bh - item.b - item.h, w: item.w, h: item.h }
    case 'cc': {
      const { x, w } = projectColumnHorizontal(item, box.x, bw, refCardW)
      return { x, y: box.y + item.b * bh - item.h * 0.5, w, h: item.h }
    }
    case 'cb': {
      const { x, w } = projectColumnHorizontal(item, box.x, bw, refCardW)
      return { x, y: box.y + bh - item.b - item.h, w, h: item.h }
    }
    case 'box': {
      const rawH = item.h * bh
      const h = item.kind === 'bar' ? Math.min(14, Math.max(7, rawH)) : rawH
      return { x: box.x + item.a * bw, y: box.y + item.b * bh, w: item.w * bw, h }
    }
  }
}

export function parseStartupBlueprint(raw: unknown): StartupBlueprint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Partial<StartupBlueprint>
  if (data.version !== 1) return null
  if (typeof data.leftOpen !== 'boolean' || typeof data.rightOpen !== 'boolean') return null
  if (typeof data.refCardW !== 'number' || !Number.isFinite(data.refCardW) || data.refCardW < 120 || data.refCardW > 8000) {
    return null
  }
  if (!Array.isArray(data.items)) return null

  const items: StartupBlueprintItem[] = []
  for (const entry of data.items.slice(0, MAX_BLUEPRINT_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue
    const it = entry as Partial<StartupBlueprintItem>
    if (it.region !== 0 && it.region !== 1 && it.region !== 2 && it.region !== 3) continue
    if (!it.kind || !VALID_KINDS.has(it.kind)) continue
    if (!it.anchor || !VALID_ANCHORS.has(it.anchor)) continue
    if (
      typeof it.a !== 'number' || !Number.isFinite(it.a) ||
      typeof it.b !== 'number' || !Number.isFinite(it.b) ||
      typeof it.w !== 'number' || !Number.isFinite(it.w) || it.w <= 0 ||
      typeof it.h !== 'number' || !Number.isFinite(it.h) || it.h <= 0 ||
      typeof it.r !== 'number' || !Number.isFinite(it.r) || it.r < 0
    ) {
      continue
    }
    items.push({
      region: it.region,
      kind: it.kind,
      anchor: it.anchor,
      a: it.a,
      b: it.b,
      w: it.w,
      h: it.h,
      r: it.r
    })
  }
  if (items.length === 0) return null
  return {
    version: 1,
    leftOpen: data.leftOpen,
    rightOpen: data.rightOpen,
    refCardW: round1(data.refCardW),
    items
  }
}
