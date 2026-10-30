import type { DragEvent as ReactDragEvent } from 'react'

/**
 * Rows of the file and change columns dragged into a composer. The payload lives in this module, not
 * only in the DataTransfer: dragover cannot read transfer data, and the composer has to know which
 * worktree the row belongs to before the drop so it can refuse one from another worktree — its paths
 * are relative to that worktree. The MIME type only proves the drag is ours and still in flight.
 */
const FILE_DRAG_TYPE = 'application/x-pig-file'

export interface FileDrag {
  cwd: string
  /** Worktree-relative and `/`-separated, without a trailing slash. */
  path: string
  isDirectory: boolean
}

let active: FileDrag | null = null

export function fileDragProps(drag: FileDrag) {
  return {
    draggable: true,
    onDragStart: (event: ReactDragEvent) => {
      active = drag
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData(FILE_DRAG_TYPE, '')
      event.dataTransfer.setData('text/plain', drag.path)
    },
    onDragEnd: () => {
      active = null
    }
  }
}

export function activeFileDrag(event: DragEvent): FileDrag | null {
  return active && event.dataTransfer?.types.includes(FILE_DRAG_TYPE) ? active : null
}
