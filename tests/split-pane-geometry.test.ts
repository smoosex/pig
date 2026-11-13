/** Enter and exit use the same outer edge; neighboring nested panes must stay out of the choice. */
import { expect, test } from 'bun:test'
import { collapsedPaneRect } from '../src/renderer/src/components/chat/split-pane-geometry'

test('pane rectangles unfold and retract from their left/right/top/bottom boundary', () => {
  const full = { left: 10, top: 20, width: 800, height: 600 }
  for (const [rect, collapsed] of [
    [{ left: 10, top: 20, width: 396, height: 600 }, { left: 10, top: 20, width: 0, height: 600 }],
    [{ left: 414, top: 20, width: 396, height: 600 }, { left: 810, top: 20, width: 0, height: 600 }],
    [{ left: 10, top: 20, width: 800, height: 296 }, { left: 10, top: 20, width: 800, height: 0 }],
    [{ left: 10, top: 324, width: 800, height: 296 }, { left: 10, top: 620, width: 800, height: 0 }]
  ]) expect(collapsedPaneRect(rect, [full])).toEqual(collapsed)
})

test('nested transitions use their overlapping source/survivor rather than a distant pane', () => {
  const nested = { left: 414, top: 20, width: 396, height: 600 }
  const unrelated = { left: 10, top: 20, width: 396, height: 600 }
  const bottom = { left: 414, top: 324, width: 396, height: 296 }
  expect(collapsedPaneRect(bottom, [unrelated, nested])).toEqual({ ...bottom, top: 620, height: 0 })
  expect(collapsedPaneRect(bottom, [unrelated])).toEqual(bottom)
})
