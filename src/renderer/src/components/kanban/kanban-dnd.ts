/**
 * Column-first collision detection for multi-column Kanban drag-and-drop:
 * `@dnd-kit`'s built-in `closestCorners` measures distance to all 4 corners of tall `h-full` columns,
 * causing drags across the middle/lower area of an empty column to lose against a small card sitting near
 * the top of an adjacent column.
 *
 * Resolving the hovered column container first guarantees 100% of an empty column's area accepts drops,
 * then refines to cards inside that column (or the column itself when below the last card).
 */
import {
  closestCenter,
  closestCorners,
  pointerWithin,
  rectIntersection,
  type CollisionDetection
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { KanbanIssue, KanbanStatus } from '../../../../shared/kanban'

/**
 * Computes `sortOrder` for dropping `dragged` into `targetStatus` column (sorted ascending by `sortOrder`),
 * handling both cross-column insertion and same-column upward/downward `arrayMove` reordering.
 */
export function computeDropSortOrder(
  sortedTargetColumn: readonly KanbanIssue[],
  dragged: Pick<KanbanIssue, 'number' | 'status'>,
  targetStatus: KanbanStatus,
  overIssueNumber: number | null
): number {
  if (dragged.status === targetStatus && overIssueNumber !== null) {
    const oldIndex = sortedTargetColumn.findIndex((i) => i.number === dragged.number)
    const newIndex = sortedTargetColumn.findIndex((i) => i.number === overIssueNumber)
    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const reordered = arrayMove([...sortedTargetColumn], oldIndex, newIndex)
      const prev = reordered[newIndex - 1]
      const next = reordered[newIndex + 1]
      if (!prev && next) return next.sortOrder - 1000
      if (prev && !next) return prev.sortOrder + 1000
      if (prev && next) return (prev.sortOrder + next.sortOrder) / 2
    }
  }

  const others = sortedTargetColumn.filter((i) => i.number !== dragged.number)
  if (others.length === 0) return 1000
  if (overIssueNumber === null) return others[others.length - 1].sortOrder + 1000

  const overIndex = others.findIndex((i) => i.number === overIssueNumber)
  if (overIndex <= 0) return others[0].sortOrder - 1000
  return (others[overIndex - 1].sortOrder + others[overIndex].sortOrder) / 2
}

export const kanbanCollisionDetection: CollisionDetection = (args) => {
  const columnContainers = args.droppableContainers.filter((c) => String(c.id).startsWith('column:'))
  if (columnContainers.length === 0) return closestCorners(args)

  const pointerCols = pointerWithin({ ...args, droppableContainers: columnContainers })
  const rectCols = pointerCols.length > 0
    ? pointerCols
    : rectIntersection({ ...args, droppableContainers: columnContainers })
  const matchedCol = (rectCols.length > 0 ? rectCols : closestCenter({ ...args, droppableContainers: columnContainers }))[0]
  if (!matchedCol) return closestCorners(args)

  const colId = String(matchedCol.id)
  const targetStatus = colId.slice('column:'.length)
  const cardContainers = args.droppableContainers.filter((c) => {
    if (!String(c.id).startsWith('issue:')) return false
    const issue = c.data.current?.issue as KanbanIssue | undefined
    return issue?.status === targetStatus
  })

  if (cardContainers.length === 0) {
    return [matchedCol]
  }

  if (args.pointerCoordinates) {
    let maxCardBottom = -Infinity
    for (const card of cardContainers) {
      const rect = args.droppableRects.get(card.id)
      if (rect && rect.bottom > maxCardBottom) maxCardBottom = rect.bottom
    }
    if (Number.isFinite(maxCardBottom) && args.pointerCoordinates.y > maxCardBottom + 16) {
      return [matchedCol]
    }
  }

  const cardMatch = closestCenter({ ...args, droppableContainers: cardContainers })
  return cardMatch.length > 0 ? cardMatch : [matchedCol]
}
