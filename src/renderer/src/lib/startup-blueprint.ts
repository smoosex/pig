/**
 * Scans the live workspace DOM into a compact, privacy-free `StartupBlueprint`.
 *
 * Only `[data-workspace-shell]` is captured (never transient Settings or Bot overlays, since cold
 * launches always open into the workspace). Text elements are measured via `Range.getClientRects()`
 * so skeleton bars match actual glyph line lengths rather than full-width block containers.
 */
import {
  encodeBlueprintItem,
  workspaceRegionBox,
  type BlueprintBox,
  type StartupBlueprint,
  type StartupBlueprintAnchor,
  type StartupBlueprintItem,
  type StartupBlueprintKind,
  type StartupBlueprintRegion
} from '../../../shared/startup-blueprint'

function toBox(r: DOMRectReadOnly): BlueprintBox {
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

function clipBox(a: BlueprintBox, clip: BlueprintBox): BlueprintBox | null {
  const x1 = Math.max(a.x, clip.x)
  const y1 = Math.max(a.y, clip.y)
  const x2 = Math.min(a.x + a.w, clip.x + clip.w)
  const y2 = Math.min(a.y + a.h, clip.y + clip.h)
  const w = x2 - x1
  const h = y2 - y1
  return w >= 6 && h >= 5 ? { x: x1, y: y1, w, h } : null
}

function isHiddenElement(el: Element): boolean {
  // Decorative elements such as `[data-sidebar-mode-pill]`, `[data-panel-pill]`, and greeting SVGs
  // carry `aria-hidden="true"` while visually rendered; only skip layout-hidden subtrees.
  return Boolean(el.closest('[hidden], [inert], .hidden, [style*="display: none"], [style*="display:none"]'))
}

function centeredGlyphBox(rect: BlueprintBox, size = 15): BlueprintBox {
  const s = Math.min(size, rect.w, rect.h)
  return {
    x: rect.x + (rect.w - s) * 0.5,
    y: rect.y + (rect.h - s) * 0.5,
    w: s,
    h: s
  }
}

function measureTextLines(el: Element, clip: BlueprintBox, maxLines = 3): BlueprintBox[] {
  const doc = el.ownerDocument
  if (typeof doc?.createRange === 'function') {
    const range = doc.createRange()
    range.selectNodeContents(el)
    const rects = Array.from(range.getClientRects())
    const lines: BlueprintBox[] = []
    for (const r of rects) {
      if (r.width < 6 || r.height < 5) continue
      const clipped = clipBox(toBox(r), clip)
      if (!clipped) continue
      const prev = lines.at(-1)
      // Merge inline spans sitting on the same visual text line.
      if (prev && Math.abs(prev.y - clipped.y) < 6) {
        const right = Math.max(prev.x + prev.w, clipped.x + clipped.w)
        prev.x = Math.min(prev.x, clipped.x)
        prev.w = right - prev.x
      } else {
        lines.push({ x: clipped.x, y: clipped.y + (clipped.h - 10) * 0.5, w: clipped.w, h: 10 })
        if (lines.length >= maxLines) break
      }
    }
    if (lines.length > 0) return lines
  }
  const fallback = clipBox(toBox(el.getBoundingClientRect()), clip)
  if (!fallback) return []
  return [{
    x: fallback.x,
    y: fallback.y + (fallback.h - 10) * 0.5,
    w: Math.min(fallback.w, 180),
    h: 10
  }]
}

function collectRowBars(
  container: Element,
  clip: BlueprintBox,
  limit: number
): BlueprintBox[] {
  const candidates = container.querySelectorAll('p, a, button, [role="button"], [role="treeitem"]')
  const seenBands = new Set<number>()
  const rows: BlueprintBox[] = []
  for (const el of candidates) {
    if (rows.length >= limit) break
    if (isHiddenElement(el)) continue
    const raw = toBox(el.getBoundingClientRect())
    if (raw.w < 16 || raw.h < 10 || raw.h > 56) continue
    const clipped = clipBox(raw, clip)
    if (!clipped) continue
    const band = Math.round(clipped.y / 18)
    if (seenBands.has(band)) continue

    const textLines = measureTextLines(el, clipped, 1)
    const bar = textLines[0] ?? {
      x: clipped.x + 8,
      y: clipped.y + (clipped.h - 10) * 0.5,
      w: Math.max(28, Math.min(176, clipped.w - 16)),
      h: 10
    }
    if (bar.w < 14) continue
    seenBands.add(band)
    rows.push(bar)
  }
  return rows
}

export function captureStartupBlueprint(
  root: ParentNode,
  options: { leftOpen: boolean; rightOpen: boolean }
): StartupBlueprint | null {
  const shell = root.querySelector<HTMLElement>('[data-workspace-shell]')
  if (!shell || isHiddenElement(shell)) return null
  const shellRect = shell.getBoundingClientRect()
  const winW = Math.round(shellRect.width)
  const winH = Math.round(shellRect.height)
  if (winW < 320 || winH < 240) return null

  const leftOpen = options.leftOpen && winW >= 648
  const rightOpen = options.rightOpen && winW >= (leftOpen ? 896 : 648)
  const headerBox = workspaceRegionBox(0, winW, winH, leftOpen, rightOpen)
  const leftBox = workspaceRegionBox(1, winW, winH, leftOpen, rightOpen)
  const centerBox = workspaceRegionBox(2, winW, winH, leftOpen, rightOpen)
  const rightBox = workspaceRegionBox(3, winW, winH, leftOpen, rightOpen)

  const items: StartupBlueprintItem[] = []
  const push = (
    rect: BlueprintBox | null,
    box: BlueprintBox,
    region: StartupBlueprintRegion,
    kind: StartupBlueprintKind,
    anchor: StartupBlueprintAnchor,
    radius: number
  ) => {
    if (!rect || rect.w < 5 || rect.h < 5 || items.length >= 60) return
    items.push(encodeBlueprintItem(rect, box, region, kind, anchor, radius))
  }

  // 1. Header (`region = 0`)
  const header = shell.querySelector('[data-app-header]')
  if (header && !isHiddenElement(header)) {
    const leadingBtns = Array.from(header.querySelectorAll('[data-header-leading] button')).filter(
      (b) => !isHiddenElement(b)
    )
    leadingBtns.forEach((btn, idx) => {
      const r = clipBox(toBox(btn.getBoundingClientRect()), headerBox)
      if (!r) return
      if (idx === 1 || btn.querySelector('[data-bot-orb]')) {
        const orb = centeredGlyphBox(r, 18)
        push(orb, headerBox, 0, 'orb', 'tl', orb.w * 0.5)
      } else {
        push(centeredGlyphBox(r, 15), headerBox, 0, 'ghost', 'tl', 4.5)
      }
    })

    const tabStrip = header.querySelector('[data-header-tabs] [role="tablist"], [data-header-tabs] > div')
    if (tabStrip && !isHiddenElement(tabStrip)) {
      const stripRect = clipBox(toBox(tabStrip.getBoundingClientRect()), headerBox)
      if (stripRect && stripRect.w >= 36) {
        push(stripRect, headerBox, 0, 'capsule', 'tc', 8)
        const activeTab = tabStrip.querySelector('[data-tab-active]')
        if (activeTab && !isHiddenElement(activeTab)) {
          const ar = clipBox(toBox(activeTab.getBoundingClientRect()), stripRect)
          push(ar, headerBox, 0, 'pill', 'tc', 6)
        }
        const inactiveTabs = Array.from(tabStrip.querySelectorAll('[role="tab"]:not([data-tab-active])'))
          .filter((el) => !isHiddenElement(el))
          .slice(0, 4)
        for (const tab of inactiveTabs) {
          const tr = clipBox(toBox(tab.getBoundingClientRect()), stripRect)
          if (tr && tr.w >= 24) {
            push(
              { x: tr.x + 8, y: tr.y + (tr.h - 8) * 0.5, w: Math.max(12, tr.w - 16), h: 8 },
              headerBox,
              0,
              'bar',
              'tc',
              4
            )
          }
        }
      }
    }

    const trailingBtns = Array.from(header.querySelectorAll('[data-header-trailing] button')).filter(
      (b) => !isHiddenElement(b)
    )
    for (const btn of trailingBtns.slice(0, 5)) {
      const r = clipBox(toBox(btn.getBoundingClientRect()), headerBox)
      if (!r) continue
      if (r.w > 40) push(r, headerBox, 0, 'capsule', 'tr', 7)
      else push(centeredGlyphBox(r, 15), headerBox, 0, 'ghost', 'tr', 4.5)
    }
  }

  // 2. Left Sidebar (`region = 1`)
  const leftRail = shell.querySelector('[data-workspace-left-rail]')
  if (leftOpen && leftRail && !isHiddenElement(leftRail) && leftBox.w > 0) {
    const modeSwitch = leftRail.querySelector('[data-slot="toggle-group"]')
    if (modeSwitch && !isHiddenElement(modeSwitch)) {
      const mr = clipBox(toBox(modeSwitch.getBoundingClientRect()), leftBox)
      if (mr) push(mr, leftBox, 1, 'capsule', 'tl', mr.h * 0.5)
      const activePill = modeSwitch.querySelector('[data-sidebar-mode-pill]')
      if (activePill && !isHiddenElement(activePill)) {
        const pr = clipBox(toBox(activePill.getBoundingClientRect()), leftBox)
        if (pr) push(pr, leftBox, 1, 'pill', 'tl', pr.h * 0.5)
      }
    }

    const scrollViewport = leftRail.querySelector('[data-slot="scroll-area-viewport"]') ?? leftRail
    const listClip: BlueprintBox = {
      x: leftBox.x,
      y: leftBox.y + 40,
      w: leftBox.w,
      h: Math.max(0, leftBox.h - 84)
    }
    for (const bar of collectRowBars(scrollViewport, listClip, 12)) {
      push(bar, leftBox, 1, 'bar', 'tl', 5)
    }

    const footerClip: BlueprintBox = {
      x: leftBox.x,
      y: leftBox.y + leftBox.h - 48,
      w: leftBox.w,
      h: 48
    }
    const footerBtns = Array.from(leftRail.querySelectorAll('button')).filter((b) => {
      if (isHiddenElement(b)) return false
      const r = b.getBoundingClientRect()
      return r.top >= footerClip.y - 4 && r.width >= 16 && r.height >= 16
    })
    for (const btn of footerBtns.slice(0, 5)) {
      const r = clipBox(toBox(btn.getBoundingClientRect()), footerClip)
      if (!r) continue
      if (r.x > leftBox.x + 150) {
        push(r, leftBox, 1, 'pill', 'bl', r.h * 0.5)
      } else {
        push(centeredGlyphBox(r, 15), leftBox, 1, 'ghost', 'bl', 4.5)
      }
    }
  }

  // 3. Center Content Card Inner (`region = 2`)
  const contentInner = shell.querySelector('[data-content-inner]')
  if (contentInner && !isHiddenElement(contentInner)) {
    const composers = Array.from(contentInner.querySelectorAll('[data-tab-reference-target]')).filter(
      (el) => !isHiddenElement(el) && el.getBoundingClientRect().width >= 80
    )
    const multiPane = composers.length > 1 || contentInner.querySelectorAll('[data-panel]').length > 1

    let primaryAnchor: StartupBlueprintAnchor = multiPane ? 'box' : 'cb'
    for (const comp of composers.slice(0, 3)) {
      const cr = clipBox(toBox(comp.getBoundingClientRect()), centerBox)
      if (!cr) continue
      const isCentered = !multiPane && cr.y + cr.h < centerBox.y + centerBox.h - 90
      const compAnchor: StartupBlueprintAnchor = multiPane ? 'box' : isCentered ? 'cc' : 'cb'
      if (comp === composers[0]) primaryAnchor = compAnchor

      push(cr, centerBox, 2, 'capsule', compAnchor, 16)
      // Editor input line
      push(
        { x: cr.x + 14, y: cr.y + 14, w: Math.min(132, Math.max(48, cr.w * 0.24)), h: 10 },
        centerBox,
        2,
        'bar',
        compAnchor,
        5
      )

      const addon = comp.querySelector('[data-slot="input-group-addon"]')
      if (addon && !isHiddenElement(addon)) {
        const addonBtns = Array.from(addon.querySelectorAll('button')).filter(
          (b) => !isHiddenElement(b) && b.getBoundingClientRect().width >= 16
        )
        const sendBtn = addonBtns.at(-1)
        for (const chip of addonBtns.slice(0, 2)) {
          if (chip === sendBtn) continue
          const br = clipBox(toBox(chip.getBoundingClientRect()), cr)
          if (br) {
            push(
              { x: br.x + 2, y: br.y + (br.h - 9) * 0.5, w: Math.max(14, br.w - 4), h: 9 },
              centerBox,
              2,
              'bar',
              compAnchor,
              4.5
            )
          }
        }
        if (sendBtn) {
          const sr = clipBox(toBox(sendBtn.getBoundingClientRect()), cr)
          if (sr) push(sr, centerBox, 2, 'orb', compAnchor, Math.min(sr.w, sr.h) * 0.5)
        }
      }
    }

    if (primaryAnchor === 'cc') {
      // Home screen: capture greeting emblem + wrapped greeting quote lines + any recent session rows
      const emptyBox = contentInner.querySelector('[data-slot="empty"]')
      if (emptyBox && !isHiddenElement(emptyBox)) {
        const svg = emptyBox.querySelector('svg')
        if (svg && !isHiddenElement(svg)) {
          const sr = clipBox(toBox(svg.getBoundingClientRect()), centerBox)
          if (sr) push(sr, centerBox, 2, 'ghost', 'cc', 10)
        }
        const quote = emptyBox.querySelector('p')
        if (quote && !isHiddenElement(quote)) {
          for (const line of measureTextLines(quote, centerBox, 3)) {
            push({ ...line, h: 12 }, centerBox, 2, 'bar', 'cc', 6)
          }
        }
      }
      const firstComp = composers[0]?.getBoundingClientRect()
      if (firstComp) {
        const belowClip: BlueprintBox = {
          x: centerBox.x,
          y: firstComp.bottom + 12,
          w: centerBox.w,
          h: Math.max(0, centerBox.y + centerBox.h - (firstComp.bottom + 16))
        }
        if (belowClip.h >= 28) {
          for (const row of collectRowBars(contentInner, belowClip, 5)) {
            push(row, centerBox, 2, 'bar', 'cc', 5)
          }
        }
      }
    } else {
      // Active session transcript / split panes / kanban / code or diff view
      const scrollers = Array.from(contentInner.querySelectorAll('[data-slot="message-scroller-viewport"]')).filter(
        (el) => !isHiddenElement(el)
      )
      if (scrollers.length > 0) {
        const transcriptShapes: Array<{ rect: BlueprintBox; kind: StartupBlueprintKind; r: number }> = []
        for (const scroller of scrollers.slice(0, 2)) {
          const sClip = clipBox(toBox(scroller.getBoundingClientRect()), centerBox)
          if (!sClip) continue
          const blocks = scroller.querySelectorAll(
            '[data-slot="bubble-content"], [data-slot="message-content"] pre, [data-slot="message-content"] p'
          )
          for (const block of blocks) {
            if (isHiddenElement(block)) continue
            if (block.tagName === 'P' && block.closest('[data-slot="bubble-content"]')) continue
            const br = clipBox(toBox(block.getBoundingClientRect()), sClip)
            if (!br) continue
            if (block.hasAttribute('data-slot') || block.tagName === 'PRE') {
              transcriptShapes.push({ rect: br, kind: 'capsule', r: 12 })
            } else {
              for (const line of measureTextLines(block, sClip, 3)) {
                transcriptShapes.push({ rect: line, kind: 'bar', r: 5 })
              }
            }
          }
        }
        for (const shape of transcriptShapes.slice(-14)) {
          push(shape.rect, centerBox, 2, shape.kind, multiPane ? 'box' : 'cb', shape.r)
        }
      } else if (composers.length === 0) {
        // Kanban / File / Changes / Terminal / Browser tab
        const cards = Array.from(contentInner.querySelectorAll('pre, [data-slot="card"], [role="region"]')).filter(
          (el) => !isHiddenElement(el)
        )
        for (const card of cards.slice(0, 8)) {
          const cr = clipBox(toBox(card.getBoundingClientRect()), centerBox)
          if (cr && cr.h >= 28 && cr.w < centerBox.w * 0.96) {
            push(cr, centerBox, 2, 'capsule', 'box', 10)
          }
        }
        for (const row of collectRowBars(contentInner, centerBox, 10)) {
          push(row, centerBox, 2, 'bar', 'box', 5)
        }
      }
    }
  }

  // 4. Right Workspace Panel (`region = 3`)
  const rightRail = shell.querySelector('[data-workspace-right-rail]')
  if (rightOpen && rightRail && !isHiddenElement(rightRail) && rightBox.w > 0) {
    const panelSwitch = rightRail.querySelector('[data-slot="toggle-group"]')
    if (panelSwitch && !isHiddenElement(panelSwitch)) {
      const sr = clipBox(toBox(panelSwitch.getBoundingClientRect()), rightBox)
      if (sr) push(sr, rightBox, 3, 'capsule', 'tl', sr.h * 0.5)
      const activePill = panelSwitch.querySelector('[data-panel-pill]')
      if (activePill && !isHiddenElement(activePill)) {
        const pr = clipBox(toBox(activePill.getBoundingClientRect()), rightBox)
        if (pr) push(pr, rightBox, 3, 'pill', 'tl', pr.h * 0.5)
      }
    }
    const rightListClip: BlueprintBox = {
      x: rightBox.x,
      y: rightBox.y + 38,
      w: rightBox.w,
      h: Math.max(0, rightBox.h - 46)
    }
    for (const bar of collectRowBars(rightRail, rightListClip, 12)) {
      push(bar, rightBox, 3, 'bar', 'tl', 4.75)
    }
  }

  if (items.length === 0) return null
  return {
    version: 1,
    leftOpen,
    rightOpen,
    refCardW: centerBox.w,
    items
  }
}
