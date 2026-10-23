/**
 * Full-window pixel animation of the startup screen, drawn on one canvas.
 *
 * `runStartupScene` is serialized with Function#toString into the screen's document, so it must
 * stay self-contained: no imports, closures or helpers from this module. It is a state machine
 * rather than a timeline because startup has no known length: tiles flip in from the center, the
 * pig appears and a coin drops into it, the scene loops while the app loads, and whenever main
 * calls `__pigStartupExit` the tiles flip away from the center outward within `exitMs`, leaving
 * the canvas transparent over the app. Everything is laid out from the viewport on each resize.
 */
export function runStartupScene(exitMs: number): void {
  const PIG = [
    '......oo...oo.....',
    '.....oppo.oppo....',
    '...oopppoooppo....',
    '..opppppppppppo...',
    '.oppppppppdpopoo..',
    'oppppppppppppppo..',
    'opppppppppppooooo.',
    'oppppppppppooooooo',
    'oppppppppppododooo',
    'oppppppppppododooo',
    '.opppppppppoooooo.',
    '..opppppppppoooo..',
    '..opooooooo..o....',
    '...oo......oo.....'
  ]
  const COIN = ['..ggg..', '.g...g.', 'g.ggg.g', 'g.ggg.g', 'g.ggg.g', '.g...g.', '..ggg..']
  const OUTLINE = '#c2416a'
  const DARK = '#5a1c33'
  const PINK = '#fcd0d8'
  const PINK_SHADE = '#f6b9c6'
  const GOLD = '#ffc94a'
  const GOLD_BACK = '#e8ab3a'
  const CREAM = '#ffe7a3'
  const BASE = '#171842'
  const TILE_MS = 260
  const COIN_EVERY_MS = 2600

  const canvas = document.querySelector('canvas')!
  const ctx = canvas.getContext('2d')!
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  let seed = 0x9e3779b9
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  const step = (value: number, levels: number) => Math.ceil(clamp(value) * levels) / levels
  const easeOutBack = (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2

  interface Star { x: number; y: number; kind: number; phase: number; period: number; color: string }
  interface Tile { x: number; y: number; enter: number; exit: number }
  interface Drop { start: number }
  interface Meteor { x: number; y: number; vx: number; vy: number; size: number; alpha: number; spin: number }
  interface Spark { x: number; y: number; vx: number; vy: number; born: number; color: string }

  let W = 0, H = 0, P = 0, S = 0, T = 0, M = 0
  let pigX = 0, pigY = 0
  let stars: Star[] = []
  let tiles: Tile[] = []
  let entryEnd = 0
  let background: CanvasGradient | undefined
  let glow: CanvasGradient | undefined
  const drops: Drop[] = []
  const meteors: Meteor[] = []
  const sparks: Spark[] = []
  let nextDrop = 650
  let nextMeteor = 1200
  let squashUntil = 0
  let start = -1
  let exitAt: number | null = null
  let done = false

  const layout = () => {
    const dpr = window.devicePixelRatio || 1
    W = canvas.width = Math.round(innerWidth * dpr)
    H = canvas.height = Math.round(innerHeight * dpr)
    M = Math.min(W, H)
    P = Math.max(4, Math.round(M * 0.0135))
    S = Math.max(2, Math.round(M * 0.0055))
    T = Math.max(16, Math.round(M * 0.045))
    pigX = Math.round((W - PIG[0].length * P) / 2)
    pigY = Math.round(H * 0.46 - (PIG.length * P) / 2)

    background = ctx.createLinearGradient(0, 0, W, H)
    background.addColorStop(0, '#3b3f8e')
    background.addColorStop(1, '#1d1d4c')
    const cx = W / 2, cy = pigY + (PIG.length * P) / 2
    glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, M * 0.55)
    glow.addColorStop(0, 'rgba(150, 130, 255, .26)')
    glow.addColorStop(1, 'rgba(150, 130, 255, 0)')

    seed = 0x9e3779b9
    stars = []
    const keepOut = { left: pigX - 8 * P, right: pigX + 26 * P, top: pigY - 12 * P, bottom: pigY + 22 * P }
    const count = Math.round((W * H) / (S * 30) ** 2)
    for (let i = 0; i < count; i++) {
      const x = Math.floor((random() * W) / S) * S
      const y = Math.floor((random() * H) / S) * S
      if (x > keepOut.left && x < keepOut.right && y > keepOut.top && y < keepOut.bottom) continue
      const roll = random()
      stars.push({
        x, y,
        kind: roll < 0.6 ? 0 : roll < 0.9 ? 1 : 2,
        phase: random() * 4000,
        period: 1600 + random() * 1800,
        color: random() < 0.7 ? CREAM : GOLD
      })
    }

    tiles = []
    const far = Math.hypot(W / 2, H / 2)
    const exitSpread = Math.max(0, exitMs - TILE_MS - 100)
    for (let y = 0; y < H; y += T) {
      for (let x = 0; x < W; x += T) {
        const d = Math.hypot(x + T / 2 - W / 2, y + T / 2 - H / 2) / far
        tiles.push({ x, y, enter: d * 480 + random() * 90, exit: d * exitSpread + random() * 100 })
      }
    }
    entryEnd = Math.max(...tiles.map((tile) => tile.enter)) + TILE_MS
  }

  const cell = (g: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) => {
    g.fillStyle = color
    g.fillRect(x, y, size, size)
  }

  const drawStar = (star: Star, t: number) => {
    const wave = (Math.sin(((t + star.phase) / star.period) * Math.PI * 2) + 1) / 2
    const level = reduced ? 0.6 : step(wave, 3)
    ctx.globalAlpha = 0.25 + level * 0.75
    const { x, y } = star
    cell(ctx, x, y, S, star.color)
    if (star.kind === 0 || level < 0.5) return
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (star.kind === 1) cell(ctx, x + dx * S, y + dy * S, S, star.color)
      else cell(ctx, x + dx * 2 * S, y + dy * 2 * S, S, star.color)
    }
    if (star.kind === 2) {
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) cell(ctx, x + dx * S, y + dy * S, S, star.color)
    }
  }

  // The coin spins by resampling its columns to the projected width; the back face is darker.
  const drawCoin = (cx: number, cy: number, size: number, angle: number) => {
    const turn = Math.cos(angle)
    const width = Math.max(1, Math.round(7 * Math.abs(turn)))
    const left = Math.round(cx - (width * size) / 2)
    const top = Math.round(cy - 3.5 * size)
    const color = width <= 2 ? GOLD_BACK : turn < 0 ? GOLD_BACK : GOLD
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < width; col++) {
        const source = width <= 2 ? 3 : Math.floor(((col + 0.5) / width) * 7)
        if (width <= 2 || COIN[row][source] === 'g') cell(ctx, left + col * size, top + row * size, size, color)
      }
    }
  }

  const drawPig = (t: number, alpha: number, lift: number) => {
    const bob = reduced || t < 1000 ? 0 : Math.floor(t / 560) % 2 === 1 ? -Math.round(P / 2) : 0
    const squash = t < squashUntil ? Math.round(P / 2) : 0
    const top = pigY + lift + bob + squash
    ctx.globalAlpha = alpha * 0.3
    ctx.fillStyle = '#0b0a26'
    const shadow = (bob ? 8 : 10) * P
    ctx.fillRect(Math.round(pigX + 9 * P - shadow / 2), pigY + PIG.length * P + Math.round(P / 3), shadow, Math.round(P / 2))
    ctx.globalAlpha = alpha
    for (let row = 0; row < PIG.length; row++) {
      for (let col = 0; col < PIG[row].length; col++) {
        const kind = PIG[row][col]
        if (kind === '.') continue
        const color = kind === 'o' ? OUTLINE : kind === 'd' ? DARK : row + col * 0.35 > 10.5 ? PINK_SHADE : PINK
        cell(ctx, pigX + col * P, top + row * P, P, color)
      }
    }
    if (alpha === 1) cell(ctx, pigX + 3 * P, top + 4 * P, P, '#ffe8ec')
  }

  const burst = (t: number) => {
    const x = pigX + 9.5 * P, y = pigY + 2 * P
    const colors = [GOLD, CREAM, '#f29bb0']
    for (let i = 0; i < 12; i++) {
      const angle = -Math.PI * (0.1 + 0.8 * random())
      const speed = P * (0.012 + random() * 0.018)
      sparks.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, born: t, color: colors[i % 3] })
    }
    squashUntil = t + 140
  }

  const render = (t: number, dt: number) => {
    ctx.globalAlpha = 1
    ctx.fillStyle = background!
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = glow!
    ctx.fillRect(0, 0, W, H)
    for (const star of stars) drawStar(star, t)

    if (!reduced) {
      if (t >= nextMeteor && exitAt === null) {
        const depth = 0.35 + random() * 0.4
        meteors.push({
          x: W * (0.2 + random()), y: -10 * P,
          vx: -P * (0.004 + random() * 0.004) * depth * 3, vy: P * 0.012 * depth * 2,
          size: Math.max(2, Math.round(P * depth * 0.6)), alpha: 1, spin: random() * 6
        })
        nextMeteor = t + 650 + random() * 750
      }
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i]
        m.x += m.vx * dt
        m.y += m.vy * dt
        if (m.y > H + 10 * P || m.x < -10 * P) { meteors.splice(i, 1); continue }
        for (let k = 1; k <= 3; k++) {
          ctx.globalAlpha = m.alpha * (0.6 - k * 0.15)
          cell(ctx, Math.round(m.x - m.vx * k * 40), Math.round(m.y - m.vy * k * 40), m.size, CREAM)
        }
        ctx.globalAlpha = m.alpha
        drawCoin(m.x, m.y, m.size, t * 0.008 + m.spin)
      }
    }

    // Coins fall behind the pig and disappear into the slot between its ears.
    if (!reduced && t >= nextDrop && exitAt === null) {
      drops.push({ start: t })
      nextDrop = t + COIN_EVERY_MS
    }
    const slotX = pigX + 9.5 * P
    const slotY = pigY + 2 * P
    for (let i = drops.length - 1; i >= 0; i--) {
      const age = t - drops[i].start
      if (age >= 560) { drops.splice(i, 1); burst(t); continue }
      const fall = clamp((age - 260) / 300) ** 2
      const from = slotY - 9 * P, to = slotY + 3.5 * P
      ctx.globalAlpha = step(age / 120, 3)
      drawCoin(slotX, Math.round(from + (to - from) * fall), P, age * 0.014)
    }

    const intro = reduced ? 1 : clamp((t - 380) / 320)
    drawPig(t, step(intro, 3), Math.round((1 - step(intro, 3)) * 3) * P)

    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]
      const life = (t - s.born) / 650
      if (life >= 1) { sparks.splice(i, 1); continue }
      s.vy += P * 0.00006 * dt
      s.x += s.vx * dt
      s.y += s.vy * dt
      ctx.globalAlpha = step(1 - life, 3)
      cell(ctx, Math.round(s.x / P) * P, Math.round(s.y / P) * P, life < 0.5 ? P : Math.round(P / 2), s.color)
    }

    const title = reduced ? 1 : clamp((t - 900) / 300)
    if (title > 0) {
      ctx.globalAlpha = title * 0.92
      ctx.fillStyle = '#f4f1ff'
      ctx.font = `650 ${Math.round(Math.min(Math.max(M * 0.034, 18), 44))}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText('Pig', W / 2, pigY + (PIG.length + 3.2) * P + Math.round((1 - title) * P))
    }
    ctx.globalAlpha = 1
  }

  // The scene is drawn straight onto the canvas; while tiles flip, one mask pass keeps it inside
  // the tiles and one pass puts the opaque base behind them, so a frame costs the same at any
  // window size. The base keeps the window from being see-through while the tiles flip in.
  const composite = (t: number) => {
    if (reduced) {
      if (exitAt !== null) canvas.style.opacity = String(1 - clamp((t - exitAt) / (exitMs * 0.5)))
      return
    }
    if (exitAt === null && t >= entryEnd) return
    const shown = new Path2D()
    const base = new Path2D()
    const flashes: Array<[number, number, number, number, number]> = []
    let anyShown = false
    for (const tile of tiles) {
      const leave = exitAt === null ? 0 : clamp((t - exitAt - tile.exit) / TILE_MS)
      if (leave >= 1) continue
      // Only the width folds, so tiles that have just started never open seams above or below.
      const flipX = Math.cos((leave * leave * Math.PI) / 2)
      const cx = tile.x + T / 2, cy = tile.y + T / 2
      const baseW = Math.round(T * flipX), baseH = T
      if (baseW <= 0) continue
      const left = Math.round(cx - baseW / 2), top = Math.round(cy - baseH / 2)
      base.rect(left, top, baseW, baseH)
      const enter = clamp((t - tile.enter) / TILE_MS)
      const grow = enter >= 1 ? 1 : easeOutBack(enter)
      const w = Math.round(T * grow * flipX), h = Math.round(T * grow)
      if (w > 0 && h > 0) {
        shown.rect(Math.round(cx - w / 2), Math.round(cy - h / 2), w, h)
        anyShown = true
      }
      if (leave > 0) flashes.push([left, top, baseW, baseH, leave])
    }
    ctx.globalAlpha = 1
    // Skia skips filling an empty path, so an empty mask would leave the whole scene showing
    // instead of clearing it (the last frames of the exit, the first of the entry).
    if (anyShown) {
      ctx.globalCompositeOperation = 'destination-in'
      ctx.fill(shown)
    } else {
      ctx.clearRect(0, 0, W, H)
    }
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = BASE
    ctx.fill(base)
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = '#c8c0ff'
    for (const [left, top, width, height, leave] of flashes) {
      ctx.globalAlpha = leave * 0.45
      ctx.fillRect(left, top, width, height)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  let last = 0
  // One clock for the start, the exit and every frame; rAF timestamps can run on another timeline.
  const frame = () => {
    if (done) return
    const now = performance.now()
    if (start < 0) start = now
    const t = now - start
    if (exitAt !== null && t - exitAt >= exitMs) {
      done = true
      ctx.clearRect(0, 0, W, H)
      canvas.style.opacity = '0'
      return
    }
    render(t, Math.min(48, t - last))
    composite(t)
    last = t
    requestAnimationFrame(frame)
  }

  ;(window as unknown as { __pigStartupExit: () => void }).__pigStartupExit = () => {
    if (exitAt === null && start >= 0) exitAt = performance.now() - start
  }
  addEventListener('resize', layout)
  layout()
  frame()
}
