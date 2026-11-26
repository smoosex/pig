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

export type ComposerDragKind = 'files' | 'tab' | 'text'

export function activeFileDrag(event: Pick<DragEvent, 'dataTransfer'>): FileDrag | null {
  return active && event.dataTransfer?.types.includes(FILE_DRAG_TYPE) ? active : null
}

export function hasDraggedImageFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files.length > 0) {
    return [...dataTransfer.files].some((file) => file.type.startsWith('image/'))
  }
  return [...(dataTransfer.items ?? [])].some((item) => item.kind === 'file' && item.type.startsWith('image/'))
}

export function draggedImageFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return []
  if (dataTransfer.files.length > 0) {
    return [...dataTransfer.files].filter((file) => file.type.startsWith('image/'))
  }
  return [...(dataTransfer.items ?? [])].flatMap((item) => {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

/**
 * Classifies an HTML5 drag event hovering over the composer. Returns null when the editor is
 * locked, the drag originated from a selection inside the editor itself, or a workspace row comes
 * from a different worktree.
 */
export function classifyComposerDrag(
  event: Pick<DragEvent, 'dataTransfer'>,
  options: {
    editable: boolean
    disabled?: boolean
    cwd?: string | null
    bashMode?: boolean
    internalDragging?: boolean
  }
): ComposerDragKind | null {
  if (!options.editable || options.disabled || options.internalDragging) return null
  const data = event.dataTransfer
  if (!data) return null

  const workspaceFile = activeFileDrag(event)
  if (workspaceFile) {
    return workspaceFile.cwd === options.cwd ? 'files' : null
  }

  if (data.types.includes('Files')) {
    return !options.bashMode && hasDraggedImageFiles(data) ? 'files' : null
  }

  if (data.types.includes('text/plain')) {
    return 'text'
  }

  return null
}
