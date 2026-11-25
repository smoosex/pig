/**
 * Blueprint-aligned workspace skeleton + Jade Border-Beam startup scene.
 *
 * `runStartupScene` is serialized with Function#toString into the sandboxed startup document, so it
 * must remain completely self-contained (zero external runtime closures). It projects the persisted
 * `StartupBlueprint` (or a clean empty-home fallback on first install) to the live window size so
 * every frosted shape sits 1:1 over the real UI element that sharpens out of blur beneath it.
 */
import type { StartupBlueprint, StartupBlueprintItem } from '../shared/startup-blueprint'

export interface StartupSceneConfig {
  surfaceStyle?: 'glass' | 'solid'
  leftOpen?: boolean
  rightOpen?: boolean
  lightTheme?: 'pig' | 'everforest'
  darkTheme?: 'pig' | 'everforest'
  blueprint?: StartupBlueprint | null
}

export function runStartupScene(exitMs: number, initialConfig: StartupSceneConfig = {}): void {
  const canvas = document.querySelector('canvas')!
  const ctx = canvas.getContext('2d')!
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)')
  const darkQuery = matchMedia('(prefers-color-scheme: dark)')

  let reduced = reducedQuery.matches
  let dark = darkQuery.matches
  let glass = initialConfig.surfaceStyle === 'glass'
  const bp = initialConfig.blueprint ?? null
  const leftPref = bp ? bp.leftOpen : initialConfig.leftOpen !== false
  const rightPref = bp ? bp.rightOpen : Boolean(initialConfig.rightOpen)
  const refCardW = bp ? bp.refCardW : 836
  const lightTheme = initialConfig.lightTheme === 'everforest' ? 'everforest' : 'pig'
  const darkTheme = initialConfig.darkTheme === 'everforest' ? 'everforest' : 'pig'
  let dpr = 1
  let w = 0
  let h = 0

  // First-install fallback calibrated from Pig's real 1100x760 Empty Home DOM (`refCardW = 836`):
  // 3-segment switcher with active `Projects` pill, single empty-projects hint, 3 trailing header
  // icons (new / bookmarks / right-panel), bottom sidebar controls, centered greeting emblem + quote,
  // and 768x128 (`max-w-3.5xl px-8`) centered composer.
  const fallbackItems: StartupBlueprintItem[] = [
    { region: 0, kind: 'ghost', anchor: 'tl', a: 86.5, b: 13.5, w: 15, h: 15, r: 4.5 },
    { region: 0, kind: 'orb', anchor: 'tl', a: 117, b: 11, w: 18, h: 18, r: 9 },
    { region: 0, kind: 'ghost', anchor: 'tr', a: 82.5, b: 13.5, w: 15, h: 15, r: 4.5 },
    { region: 0, kind: 'ghost', anchor: 'tr', a: 50.5, b: 13.5, w: 15, h: 15, r: 4.5 },
    { region: 0, kind: 'ghost', anchor: 'tr', a: 18.5, b: 13.5, w: 15, h: 15, r: 4.5 },
    { region: 1, kind: 'capsule', anchor: 'tl', a: 12, b: 8, w: 149.1, h: 30, r: 15 },
    { region: 1, kind: 'pill', anchor: 'tl', a: 14, b: 10, w: 82, h: 26, r: 13 },
    { region: 1, kind: 'bar', anchor: 'tl', a: 16, b: 56.8, w: 150.6, h: 10, r: 5 },
    { region: 1, kind: 'ghost', anchor: 'bl', a: 18.5, b: 14.5, w: 15, h: 15, r: 4.5 },
    { region: 1, kind: 'ghost', anchor: 'bl', a: 48.5, b: 14.5, w: 15, h: 15, r: 4.5 },
    { region: 1, kind: 'pill', anchor: 'bl', a: 222, b: 11, w: 22, h: 22, r: 11 },
    { region: 2, kind: 'ghost', anchor: 'cc', a: 0, b: 0.165, w: 42, h: 42, r: 10 },
    { region: 2, kind: 'bar', anchor: 'cc', a: 0, b: 0.252, w: 289.5, h: 12, r: 6 },
    { region: 2, kind: 'bar', anchor: 'cc', a: 0, b: 0.286, w: 303.5, h: 12, r: 6 },
    { region: 2, kind: 'capsule', anchor: 'cc', a: 0, b: 0.505, w: 768, h: 128, r: 16 },
    { region: 2, kind: 'bar', anchor: 'cc', a: -308, b: 0.448, w: 124.6, h: 10, r: 5 },
    { region: 2, kind: 'bar', anchor: 'cc', a: -298, b: 0.558, w: 146.8, h: 9, r: 4.5 },
    { region: 2, kind: 'bar', anchor: 'cc', a: -188, b: 0.558, w: 57.4, h: 9, r: 4.5 },
    { region: 2, kind: 'orb', anchor: 'cc', a: 361, b: 0.558, w: 24, h: 24, r: 12 }
  ]
  const items = bp?.items?.length ? bp.items : fallbackItems

  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const easeOutCubic = (x: number) => 1 - (1 - clamp(x)) ** 3

  const roundRect = (x: number, y: number, rw: number, rh: number, r: number): Path2D => {
    const p = new Path2D()
    const cw = Math.max(0, rw)
    const ch = Math.max(0, rh)
    p.roundRect(x, y, cw, ch, Math.min(Math.max(0, r), cw * 0.5, ch * 0.5))
    return p
  }

  const projectColX = (item: StartupBlueprintItem, bx: number, sw: number): [number, number] => {
    const refColW = Math.max(120, Math.min(832, refCardW) - 64)
    const curColW = Math.max(120, Math.min(832, sw) - 64)
    if (item.w >= refColW * 0.85) {
      const sc = curColW / refColW
      const pw = item.w * sc
      return [bx + sw * 0.5 + item.a * sc - pw * 0.5, pw]
    }
    const pw = Math.min(item.w, curColW)
    const edgeDelta = (curColW - refColW) * 0.5
    const offset = item.a < -refColW * 0.15
      ? item.a - edgeDelta
      : item.a > refColW * 0.15
        ? item.a + edgeDelta
        : item.a
    return [bx + sw * 0.5 + offset - pw * 0.5, pw]
  }

  const projectItem = (
    item: StartupBlueprintItem,
    bx: number,
    by: number,
    bw: number,
    bh: number
  ): [number, number, number, number] => {
    const sw = Math.max(1, bw)
    const sh = Math.max(1, bh)
    switch (item.anchor) {
      case 'tl':
        return [bx + item.a, by + item.b, Math.min(item.w, Math.max(0, sw - item.a - 4)), item.h]
      case 'tr':
        return [bx + sw - item.a - item.w, by + item.b, item.w, item.h]
      case 'tc': {
        const avail = item.region === 0 ? Math.max(80, sw - 512) : Math.max(80, sw - 32)
        const sc = item.w > avail ? avail / Math.max(1, item.w) : 1
        const pw = item.w * sc
        return [bx + sw * 0.5 + item.a * sc - pw * 0.5, by + item.b, pw, item.h]
      }
      case 'bl':
        return [bx + item.a, by + sh - item.b - item.h, Math.min(item.w, Math.max(0, sw - item.a - 4)), item.h]
      case 'br':
        return [bx + sw - item.a - item.w, by + sh - item.b - item.h, item.w, item.h]
      case 'cc': {
        const [px, pw] = projectColX(item, bx, sw)
        return [px, by + item.b * sh - item.h * 0.5, pw, item.h]
      }
      case 'cb': {
        const [px, pw] = projectColX(item, bx, sw)
        return [px, by + sh - item.b - item.h, pw, item.h]
      }
      case 'box': {
        const rawH = item.h * sh
        const ph = item.kind === 'bar' ? Math.min(14, Math.max(7, rawH)) : rawH
        return [bx + item.a * sw, by + item.b * sh, item.w * sw, ph]
      }
    }
  }

  const pointOnRoundedRect = (
    x: number,
    y: number,
    rw: number,
    rh: number,
    r: number,
    dist: number,
  ): [number, number] => {
    const cr = Math.min(r, rw * 0.5, rh * 0.5)
    const topW = Math.max(0, rw - 2 * cr)
    const sideH = Math.max(0, rh - 2 * cr)
    const arc = 0.5 * Math.PI * cr
    const total = 2 * topW + 2 * sideH + 4 * arc
    if (total <= 0) return [x, y]

    let s = ((dist % total) + total) % total
    if (s < topW) return [x + cr + s, y]
    s -= topW
    if (s < arc) {
      const a = -Math.PI * 0.5 + (s / arc) * (Math.PI * 0.5)
      return [x + rw - cr + Math.cos(a) * cr, y + cr + Math.sin(a) * cr]
    }
    s -= arc
    if (s < sideH) return [x + rw, y + cr + s]
    s -= sideH
    if (s < arc) {
      const a = (s / arc) * (Math.PI * 0.5)
      return [x + rw - cr + Math.cos(a) * cr, y + rh - cr + Math.sin(a) * cr]
    }
    s -= arc
    if (s < topW) return [x + rw - cr - s, y + rh]
    s -= topW
    if (s < arc) {
      const a = Math.PI * 0.5 + (s / arc) * (Math.PI * 0.5)
      return [x + cr + Math.cos(a) * cr, y + rh - cr + Math.sin(a) * cr]
    }
    s -= arc
    if (s < sideH) return [x, y + rh - cr - s]
    s -= sideH
    const a = Math.PI + (s / Math.max(arc, 0.0001)) * (Math.PI * 0.5)
    return [x + cr + Math.cos(a) * cr, y + cr + Math.sin(a) * cr]
  }

  const layout = () => {
    dpr = window.devicePixelRatio || 1
    w = Math.max(1, innerWidth)
    h = Math.max(1, innerHeight)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }

  const start = performance.now()
  let exitAt: number | null = null
  let done = false

  const regionDissolve = (elapsedExit: number, delayMs: number, durationMs: number): number => {
    if (elapsedExit <= delayMs) return 1
    return 1 - easeOutCubic((elapsedExit - delayMs) / durationMs)
  }

  const render = (t: number) => {
    const exiting = exitAt !== null
    const elapsedExit = exiting ? Math.max(0, t - exitAt!) : 0
    const leave = exiting ? clamp(elapsedExit / exitMs) : 0
    const beamFade = 1 - easeOutCubic(leave)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (beamFade <= 0.002) return

    const palette = dark ? darkTheme : lightTheme
    const headerH = 40
    const leftW = leftPref && w >= 648 ? 248 : 0
    const rightW = rightPref && w >= (leftW > 0 ? 896 : 648) ? 248 : 0
    const cardX = leftW + 8
    const cardY = headerH + 8
    const cardW = Math.max(200, w - leftW - rightW - 16)
    const cardH = Math.max(120, h - headerH - 16)
    const cardR = 11.2
    const cardPath = roundRect(cardX, cardY, cardW, cardH, cardR)

    const primaryRgb = dark
      ? (palette === 'everforest' ? '167, 192, 128' : '131, 192, 146')
      : (palette === 'everforest' ? '67, 84, 22' : '56, 103, 80')

    // 1. Static window & center-card frame (only while underlying real DOM is hidden).
    // Once exit starts, `[data-app-surface]` and `[data-content-surface]` are live at 100% opacity
    // directly underneath at the exact same coordinates, so dropping the canvas fill avoids doubling.
    if (!exiting) {
      if (!glass) {
        ctx.fillStyle = dark
          ? (palette === 'everforest' ? '#343f44' : '#282f32')
          : (palette === 'everforest' ? '#efebd4' : '#e5eaf0')
        ctx.fillRect(0, 0, w, h)

        ctx.save()
        ctx.shadowColor = dark ? 'rgba(0, 0, 0, 0.24)' : 'rgba(0, 0, 0, 0.08)'
        ctx.shadowBlur = 10
        ctx.shadowOffsetY = 2
        ctx.fillStyle = dark
          ? (palette === 'everforest' ? '#2d353b' : '#1e1f21')
          : (palette === 'everforest' ? '#fdf6e3' : '#f8f8fa')
        ctx.fill(cardPath)
        ctx.restore()
      } else {
        ctx.save()
        if (dark) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.018)'
          ctx.fill(cardPath)
          const sheen = ctx.createLinearGradient(0, cardY, 0, cardY + cardH * 0.45)
          sheen.addColorStop(0, 'rgba(255, 255, 255, 0.045)')
          sheen.addColorStop(0.32, 'rgba(255, 255, 255, 0.012)')
          sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
          ctx.fillStyle = sheen
          ctx.fill(cardPath)
          ctx.strokeStyle = 'rgba(236, 236, 236, 0.08)'
          ctx.lineWidth = 1
          ctx.stroke(cardPath)
        } else {
          ctx.fillStyle = 'rgba(248, 248, 248, 0.50)'
          ctx.fill(cardPath)
          ctx.strokeStyle = 'rgba(41, 41, 41, 0.14)'
          ctx.lineWidth = 1
          ctx.stroke(cardPath)
        }
        ctx.restore()
      }
    }

    // Soft ambient emerald breath
    const breath = reduced ? 0.5 : 0.5 + 0.5 * Math.sin((t / 2600) * Math.PI * 2)
    ctx.save()
    ctx.globalAlpha = beamFade
    const aura = ctx.createRadialGradient(cardX + cardW * 0.26, cardY + cardH * 0.20, 0, cardX + cardW * 0.38, cardY + cardH * 0.42, Math.max(w, h) * 0.65)
    aura.addColorStop(0, `rgba(${primaryRgb}, ${(dark ? 0.038 + breath * 0.015 : 0.022 + breath * 0.010).toFixed(3)})`)
    aura.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = aura
    ctx.fillRect(0, 0, w, h)
    ctx.restore()

    // 2. Render blueprint items grouped by region (`0` header, `1` left, `2` center, `3` right)
    const regionBoxes: Array<[number, number, number, number]> = [
      [0, 0, w, headerH],
      [0, headerH, leftW, Math.max(0, h - headerH)],
      [cardX, cardY, cardW, cardH],
      [w - rightW, headerH, rightW, Math.max(0, h - headerH)]
    ]
    const regionDelays = [0, 80, 160, 240]

    for (let reg = 0; reg < 4; reg++) {
      const [bx, by, bw, bh] = regionBoxes[reg]
      if (bw <= 0 || bh <= 0) continue
      const regAlpha = exiting ? regionDissolve(elapsedExit, regionDelays[reg], 240) : 1
      if (regAlpha <= 0.004) continue

      ctx.save()
      ctx.globalAlpha = regAlpha
      if (reg === 2) ctx.clip(cardPath)
      else ctx.clip(roundRect(bx, by, bw, bh, 0))

      let idx = 0
      for (const item of items) {
        if (item.region !== reg) continue
        const [ix, iy, iw, ih] = projectItem(item, bx, by, bw, bh)
        if (iw < 3 || ih < 3) continue
        const wave = reduced ? 0.9 : 0.78 + 0.22 * (0.5 + 0.5 * Math.sin((t / 1900) * Math.PI * 2 - idx * 0.28))
        idx++
        const p = roundRect(ix, iy, iw, ih, item.r)

        switch (item.kind) {
          case 'capsule': {
            ctx.fillStyle = dark
              ? `rgba(255, 255, 255, ${(0.028 * wave).toFixed(4)})`
              : `rgba(41, 43, 48, ${(0.035 * wave).toFixed(4)})`
            ctx.fill(p)
            ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.075)' : 'rgba(41, 43, 48, 0.085)'
            ctx.lineWidth = 1
            ctx.stroke(p)
            break
          }
          case 'pill': {
            ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.072)' : 'rgba(255, 255, 255, 0.72)'
            ctx.fill(p)
            ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.13)' : 'rgba(41, 43, 48, 0.08)'
            ctx.lineWidth = 1
            ctx.stroke(p)
            break
          }
          case 'bar': {
            const a = (dark ? 0.056 : 0.068) * wave
            ctx.fillStyle = dark ? `rgba(236, 238, 242, ${a.toFixed(4)})` : `rgba(41, 43, 48, ${a.toFixed(4)})`
            ctx.fill(p)
            break
          }
          case 'ghost': {
            const a = (dark ? 0.068 : 0.078) * wave
            ctx.fillStyle = dark ? `rgba(236, 238, 242, ${a.toFixed(4)})` : `rgba(41, 43, 48, ${a.toFixed(4)})`
            ctx.fill(p)
            break
          }
          case 'orb': {
            const cx = ix + iw * 0.5
            const cy = iy + ih * 0.5
            const rad = Math.min(iw, ih) * 0.5
            if (reg === 0) {
              const glow = ctx.createRadialGradient(cx, cy, 1, cx, cy, rad * 1.55)
              glow.addColorStop(0, `rgba(${primaryRgb}, ${dark ? '0.45' : '0.32'})`)
              glow.addColorStop(1, `rgba(${primaryRgb}, 0)`)
              ctx.fillStyle = glow
              ctx.beginPath()
              ctx.arc(cx, cy, rad * 1.55, 0, Math.PI * 2)
              ctx.fill()
            }
            ctx.fillStyle = `rgba(${primaryRgb}, ${(reg === 0 ? (dark ? 0.72 : 0.62) : (dark ? 0.30 : 0.24)) * wave})`
            ctx.fill(p)
            break
          }
        }
      }
      ctx.restore()
    }

    // 3. Continuous Jade Border-Beam gliding around the Center Card perimeter
    ctx.save()
    ctx.globalAlpha = beamFade
    const crClamped = Math.min(cardR, cardW * 0.5, cardH * 0.5)
    const perimeter = 2 * Math.max(0, cardW - 2 * crClamped) + 2 * Math.max(0, cardH - 2 * crClamped) + 2 * Math.PI * crClamped
    const beamLen = Math.min(320, perimeter * 0.19)
    const lapMs = 3400
    const headDist = reduced
      ? cardW * 0.62
      : cardW * 0.30 + (t / lapMs) * perimeter + easeOutCubic(leave) * 180
    const tailDist = headDist - beamLen

    const [tx, ty] = pointOnRoundedRect(cardX, cardY, cardW, cardH, cardR, tailDist)
    const [hx, hy] = pointOnRoundedRect(cardX, cardY, cardW, cardH, cardR, headDist)
    const safeHx = Math.abs(hx - tx) + Math.abs(hy - ty) < 1 ? hx + 1 : hx
    const beamGrad = ctx.createLinearGradient(tx, ty, safeHx, hy)
    const haloGrad = ctx.createLinearGradient(tx, ty, safeHx, hy)

    if (dark) {
      beamGrad.addColorStop(0, `rgba(${primaryRgb}, 0)`)
      beamGrad.addColorStop(0.55, `rgba(${primaryRgb}, 0.52)`)
      beamGrad.addColorStop(0.88, 'rgba(232, 248, 228, 0.94)')
      beamGrad.addColorStop(1, 'rgba(232, 248, 228, 0)')

      haloGrad.addColorStop(0, `rgba(${primaryRgb}, 0)`)
      haloGrad.addColorStop(0.72, `rgba(${primaryRgb}, 0.15)`)
      haloGrad.addColorStop(0.90, 'rgba(186, 238, 200, 0.26)')
      haloGrad.addColorStop(1, 'rgba(186, 238, 200, 0)')
    } else {
      beamGrad.addColorStop(0, `rgba(${primaryRgb}, 0)`)
      beamGrad.addColorStop(0.55, `rgba(${primaryRgb}, 0.45)`)
      beamGrad.addColorStop(0.88, `rgba(${primaryRgb}, 0.88)`)
      beamGrad.addColorStop(1, `rgba(${primaryRgb}, 0)`)

      haloGrad.addColorStop(0, `rgba(${primaryRgb}, 0)`)
      haloGrad.addColorStop(0.75, `rgba(${primaryRgb}, 0.11)`)
      haloGrad.addColorStop(0.92, `rgba(${primaryRgb}, 0.20)`)
      haloGrad.addColorStop(1, `rgba(${primaryRgb}, 0)`)
    }

    ctx.lineCap = 'round'
    ctx.setLineDash([beamLen, perimeter * 2])
    const wrappedTail = ((tailDist % perimeter) + perimeter) % perimeter
    const offsets = wrappedTail + beamLen > perimeter
      ? [-wrappedTail, perimeter - wrappedTail]
      : [-wrappedTail]

    for (const offset of offsets) {
      ctx.lineDashOffset = offset
      ctx.strokeStyle = haloGrad
      ctx.lineWidth = 5
      ctx.stroke(cardPath)

      ctx.strokeStyle = beamGrad
      ctx.lineWidth = 1.5
      ctx.stroke(cardPath)
    }
    ctx.restore()
  }

  const frame = () => {
    if (done) return
    const t = performance.now() - start
    if (exitAt !== null && t - exitAt >= exitMs) {
      done = true
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      canvas.style.opacity = '0'
      return
    }
    render(t)
    requestAnimationFrame(frame)
  }

  reducedQuery.addEventListener('change', (e) => { reduced = e.matches })
  darkQuery.addEventListener('change', (e) => { dark = e.matches })
  const win = window as unknown as {
    __pigStartupExit: () => void
    __pigStartupSurface: (style: string) => void
  }
  win.__pigStartupExit = () => {
    if (exitAt === null) exitAt = performance.now() - start
  }
  win.__pigStartupSurface = (style: string) => {
    glass = style === 'glass'
  }
  addEventListener('resize', layout)
  layout()
  frame()
}
