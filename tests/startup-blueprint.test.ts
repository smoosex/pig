import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeBlueprintItem,
  parseStartupBlueprint,
  projectBlueprintItem,
  workspaceRegionBox
} from '../src/shared/startup-blueprint'
import { runSelf } from './helpers/subprocess.ts'

function assignRect(
  el: Element,
  rect: { x: number; y: number; width: number; height: number }
): void {
  const domRect = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect
  }
  el.getBoundingClientRect = () => domRect as DOMRect
}

async function domFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  const { captureStartupBlueprint } = await import('../src/renderer/src/lib/startup-blueprint')

  // 1. Empty Home state (centered greeting + centered composer, no center TabBar, right rail closed)
  document.body.innerHTML = `
    <div data-workspace-shell>
      <header data-app-header>
        <div data-header-leading>
          <button aria-label="Sidebar"></button>
          <button aria-label="Bot"><span data-bot-orb></span></button>
        </div>
        <div data-header-tabs></div>
        <div data-header-trailing>
          <button aria-label="New"></button>
          <button aria-label="Right"></button>
        </div>
      </header>
      <div data-workspace-left-rail>
        <div data-slot="toggle-group">
          <span data-sidebar-mode-pill aria-hidden="true"></span>
        </div>
        <div data-slot="scroll-area-viewport">
          <p id="empty-projects">Add a project to get started</p>
          <div hidden><button id="hidden-chat">Hidden chat</button></div>
        </div>
        <div id="sidebar-footer">
          <button id="btn-settings"></button>
          <button id="btn-surface"></button>
        </div>
      </div>
      <div data-content-surface>
        <div data-content-inner>
          <div data-slot="empty">
            <svg id="greeting-svg" aria-hidden="true"></svg>
            <p id="greeting-text">Yesterday is history, tomorrow is a mystery.</p>
          </div>
          <div data-tab-reference-target id="home-composer">
            <div data-slot="input-group-addon">
              <button id="model-chip"></button>
              <button id="send-btn"></button>
            </div>
          </div>
        </div>
      </div>
      <div data-workspace-right-rail></div>
    </div>
  `

  assignRect(document.querySelector('[data-workspace-shell]')!, { x: 0, y: 0, width: 1100, height: 760 })
  assignRect(document.querySelector('[data-app-header]')!, { x: 0, y: 0, width: 1100, height: 40 })
  const leadBtns = document.querySelectorAll('[data-header-leading] button')
  assignRect(leadBtns[0]!, { x: 80, y: 6, width: 28, height: 28 })
  assignRect(leadBtns[1]!, { x: 112, y: 6, width: 28, height: 28 })
  const trailBtns = document.querySelectorAll('[data-header-trailing] button')
  assignRect(trailBtns[0]!, { x: 1028, y: 6, width: 28, height: 28 })
  assignRect(trailBtns[1]!, { x: 1060, y: 6, width: 28, height: 28 })

  assignRect(document.querySelector('[data-workspace-left-rail]')!, { x: 0, y: 40, width: 248, height: 720 })
  assignRect(document.querySelector('[data-slot="toggle-group"]')!, { x: 12, y: 48, width: 156, height: 30 })
  assignRect(document.querySelector('[data-sidebar-mode-pill]')!, { x: 14, y: 50, width: 84, height: 26 })
  assignRect(document.querySelector('[data-slot="scroll-area-viewport"]')!, { x: 0, y: 82, width: 248, height: 600 })
  assignRect(document.querySelector('#empty-projects')!, { x: 16, y: 92, width: 152, height: 18 })
  assignRect(document.querySelector('#hidden-chat')!, { x: 16, y: 120, width: 140, height: 24 })
  assignRect(document.querySelector('#btn-settings')!, { x: 12, y: 724, width: 28, height: 28 })
  assignRect(document.querySelector('#btn-surface')!, { x: 214, y: 725, width: 26, height: 26 })

  assignRect(document.querySelector('[data-content-inner]')!, { x: 256, y: 48, width: 836, height: 704 })
  assignRect(document.querySelector('[data-slot="empty"]')!, { x: 256, y: 48, width: 836, height: 310 })
  assignRect(document.querySelector('#greeting-svg')!, { x: 650, y: 170, width: 48, height: 48 })
  assignRect(document.querySelector('#greeting-text')!, { x: 480, y: 242, width: 388, height: 24 })
  assignRect(document.querySelector('#home-composer')!, { x: 384, y: 360, width: 580, height: 112 })
  assignRect(document.querySelector('[data-slot="input-group-addon"]')!, { x: 384, y: 436, width: 580, height: 36 })
  assignRect(document.querySelector('#model-chip')!, { x: 396, y: 442, width: 118, height: 22 })
  assignRect(document.querySelector('#send-btn')!, { x: 928, y: 440, width: 26, height: 26 })

  const bp = captureStartupBlueprint(document, { leftOpen: true, rightOpen: false })
  assert.ok(bp, 'captures a valid blueprint for the settled empty home workspace')
  assert.equal(bp.leftOpen, true)
  assert.equal(bp.rightOpen, false)
  assert.equal(
    bp.items.some((it) => it.region === 0 && it.anchor === 'tc'),
    false,
    'does not invent a centered TabBar when zero tabs are open'
  )
  const leftBars = bp.items.filter((it) => it.region === 1 && it.kind === 'bar')
  assert.equal(leftBars.length, 1, 'captures only the visible empty-project line and ignores hidden Activity tabs')
  assert.equal(
    bp.items.some((it) => it.region === 1 && it.kind === 'pill'),
    true,
    'captures the active sidebar mode pill despite aria-hidden="true"'
  )
  assert.equal(
    bp.items.some((it) => it.region === 2 && it.kind === 'ghost'),
    true,
    'captures the greeting SVG emblem despite aria-hidden="true"'
  )

  const composerCapsule = bp.items.find((it) => it.region === 2 && it.kind === 'capsule')
  assert.ok(composerCapsule, 'captures the centered home composer capsule')
  assert.equal(composerCapsule.anchor, 'cc', 'uses center-column proportional anchor for centered composer')

  // Verify 1:1 round-trip projection at identical window dimensions (1100 x 760)
  const centerBox = workspaceRegionBox(2, 1100, 760, bp.leftOpen, bp.rightOpen)
  const projectedComposer = projectBlueprintItem(composerCapsule, centerBox, bp.refCardW)
  assert.ok(Math.abs(projectedComposer.x - 384) <= 1, `expected composer x ~384, got ${projectedComposer.x}`)
  assert.ok(Math.abs(projectedComposer.y - 360) <= 1, `expected composer y ~360, got ${projectedComposer.y}`)
  assert.equal(projectedComposer.w, 580)
  assert.equal(projectedComposer.h, 112)

  // 2. Hidden shell (e.g. BotPage covering workspace) never overwrites the workspace blueprint
  document.querySelector('[data-workspace-shell]')!.setAttribute('hidden', '')
  assert.equal(captureStartupBlueprint(document, { leftOpen: true, rightOpen: false }), null)

  // 3. Kanban Board view: captures multi-column swimlanes, elevated issue cards, collapsed rail, and top sidebar row
  document.body.innerHTML = `
    <div data-workspace-shell>
      <header data-app-header>
        <div data-header-leading>
          <button aria-label="Sidebar"></button>
          <button aria-label="Bot"><span data-bot-orb></span></button>
          <button aria-label="Board"></button>
        </div>
        <div data-header-tabs></div>
        <div data-header-trailing>
          <button aria-label="Search"></button>
          <button aria-label="View"></button>
          <button aria-label="New"></button>
        </div>
      </header>
      <div data-workspace-left-rail>
        <div data-slot="scroll-area-viewport">
          <button id="kanban-all" data-sidebar-selected="true">All issues</button>
          <button id="kanban-proj">pig</button>
        </div>
      </div>
      <div data-content-surface>
        <div data-content-inner>
          <div id="col-todo" data-kanban-column="todo">
            <div id="col-todo-hdr"><svg></svg><span id="col-todo-title">Todo</span></div>
            <div id="card-1" data-kanban-card="1">Fix shortcut focus</div>
            <div id="card-2" data-kanban-card="2">Custom models GUI</div>
          </div>
          <div id="col-doing" data-kanban-column="in_progress">
            <div id="col-doing-hdr"><svg></svg><span id="col-doing-title">In progress</span></div>
            <div id="card-3" data-kanban-card="3">Kanban startup skeleton</div>
          </div>
          <button id="col-hidden" data-kanban-hidden-column="canceled">Canceled</button>
          <div class="hidden">
            <div data-tab-reference-target id="hidden-composer"></div>
          </div>
        </div>
      </div>
      <div data-workspace-right-rail></div>
    </div>
  `
  assignRect(document.querySelector('[data-workspace-shell]')!, { x: 0, y: 0, width: 1200, height: 760 })
  assignRect(document.querySelector('[data-app-header]')!, { x: 0, y: 0, width: 1200, height: 40 })
  assignRect(document.querySelector('[data-workspace-left-rail]')!, { x: 0, y: 40, width: 248, height: 720 })
  assignRect(document.querySelector('[data-slot="scroll-area-viewport"]')!, { x: 0, y: 48, width: 248, height: 620 })
  assignRect(document.querySelector('#kanban-all')!, { x: 10, y: 48, width: 228, height: 32 })
  assignRect(document.querySelector('#kanban-proj')!, { x: 10, y: 86, width: 228, height: 32 })

  assignRect(document.querySelector('[data-content-inner]')!, { x: 256, y: 48, width: 936, height: 704 })
  assignRect(document.querySelector('#col-todo')!, { x: 268, y: 60, width: 288, height: 680 })
  assignRect(document.querySelector('#col-todo-title')!, { x: 298, y: 72, width: 42, height: 16 })
  assignRect(document.querySelector('#card-1')!, { x: 276, y: 104, width: 272, height: 84 })
  assignRect(document.querySelector('#card-2')!, { x: 276, y: 196, width: 272, height: 76 })
  assignRect(document.querySelector('#col-doing')!, { x: 568, y: 60, width: 288, height: 680 })
  assignRect(document.querySelector('#col-doing-title')!, { x: 598, y: 72, width: 78, height: 16 })
  assignRect(document.querySelector('#card-3')!, { x: 576, y: 104, width: 272, height: 92 })
  assignRect(document.querySelector('#col-hidden')!, { x: 976, y: 84, width: 200, height: 36 })
  assignRect(document.querySelector('#hidden-composer')!, { x: 380, y: 600, width: 580, height: 112 })

  const kanbanBp = captureStartupBlueprint(document, { leftOpen: true, rightOpen: false })
  assert.ok(kanbanBp, 'captures Kanban board blueprint')
  const kanbanCenterCapsules = kanbanBp.items.filter((it) => it.region === 2 && it.kind === 'capsule')
  assert.equal(kanbanCenterCapsules.length, 3, 'captures 2 visible swimlane columns + 1 collapsed hidden-column pill')
  const kanbanCards = kanbanBp.items.filter((it) => it.region === 2 && it.kind === 'pill')
  assert.equal(kanbanCards.length, 3, 'captures all 3 issue cards across parallel columns')
  const kanbanSidebarBars = kanbanBp.items.filter((it) => it.region === 1 && it.kind === 'bar')
  assert.equal(kanbanSidebarBars.length, 2, 'captures the top All issues row without clipping at y+40')
  assert.ok(
    kanbanBp.items.some((it) => it.region === 1 && it.kind === 'capsule'),
    'captures active selected sidebar row highlight'
  )
}

if (process.argv[2] === '--dom-fixture') {
  await domFixture()
  process.exit(0)
}

test('startup blueprint: captures exact home geometry and ignores hidden elements', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--dom-fixture'], { timeoutMs: 10_000 })
  assert.equal(exitCode, 0, stderr || stdout)
})

test('startup blueprint: anchor projection adapts cleanly when reopening at 1100x760 after maximizing', () => {
  // Simulate capturing a bottom composer and trailing header button on a 1600x960 maximized window
  const header1600 = workspaceRegionBox(0, 1600, 960, true, true)
  const trailingIcon = encodeBlueprintItem({ x: 1564, y: 12, w: 15, h: 15 }, header1600, 0, 'ghost', 'tr', 4.5)
  const header1100 = workspaceRegionBox(0, 1100, 760, true, true)
  const projectedTrailing = projectBlueprintItem(trailingIcon, header1100, 1084)
  assert.equal(projectedTrailing.x, 1064, 'top-right icon stays 21px from the right edge of the 1100px window')

  const card1600 = workspaceRegionBox(2, 1600, 960, true, false)
  const bottomComposer = encodeBlueprintItem(
    { x: card1600.x + (card1600.w - 720) * 0.5, y: card1600.y + card1600.h - 126, w: 720, h: 112 },
    card1600,
    2,
    'capsule',
    'cb',
    16
  )
  const card1100 = workspaceRegionBox(2, 1100, 760, true, false)
  const projectedBottom = projectBlueprintItem(bottomComposer, card1100, card1600.w)
  assert.equal(
    Math.round((card1100.y + card1100.h) - (projectedBottom.y + projectedBottom.h)),
    14,
    'bottom composer stays pinned 14px above the bottom of the resized card'
  )
})

test('startup blueprint: atomic persistence validates schema and rejects malformed payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pig-blueprint-'))
  const prevPigDir = process.env.PIG_DIR
  process.env.PIG_DIR = dir
  try {
    const { flushStartupBlueprint, readStartupBlueprintSync, saveStartupBlueprint } = await import(
      '../src/main/startup-blueprint'
    )
    assert.equal(readStartupBlueprintSync(dir), null)
    await saveStartupBlueprint({ version: 99, invalid: true })
    assert.equal(readStartupBlueprintSync(dir), null, 'ignores malformed payloads')

    const valid = parseStartupBlueprint({
      version: 1,
      leftOpen: true,
      rightOpen: true,
      refCardW: 580,
      items: [{ region: 2, kind: 'capsule', anchor: 'cb', a: 0, b: 16, w: 520, h: 104, r: 16 }]
    })
    assert.ok(valid)
    await saveStartupBlueprint(valid)
    await flushStartupBlueprint()

    const loaded = readStartupBlueprintSync(dir)
    assert.deepEqual(loaded, valid)
  } finally {
    if (prevPigDir === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = prevPigDir
    await rm(dir, { recursive: true, force: true })
  }
})
