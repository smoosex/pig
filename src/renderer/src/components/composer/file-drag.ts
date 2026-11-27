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

const RASTER_IMAGE_EXT = /\.(?:a?png|jpe?g|jfif|gif|webp|avif|bmp)$/i

export type ComposerDragKind = 'files' | 'tab' | 'text'

export function activeFileDrag(event: Pick<DragEvent, 'dataTransfer'>): FileDrag | null {
  return active && event.dataTransfer?.types.includes(FILE_DRAG_TYPE) ? active : null
}

/** Reads the native OS filesystem path of a dropped `File` via preload `webUtils`, or `''` when absent. */
export function droppedFilePath(file: File): string {
  const fromBridge = typeof window !== 'undefined' ? window.api?.getPathForFile?.(file) : undefined
  if (typeof fromBridge === 'string' && fromBridge.length > 0) return fromBridge
  const legacy = (file as File & { path?: unknown }).path
  return typeof legacy === 'string' ? legacy : ''
}

export function isDraggedImageFile(file: File): boolean {
  if (file.type === 'image/svg+xml') return false
  if (file.type.startsWith('image/')) return true
  return !file.type && RASTER_IMAGE_EXT.test(file.name)
}

export function draggedFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return []
  if (dataTransfer.files.length > 0) {
    return [...dataTransfer.files]
  }
  return [...(dataTransfer.items ?? [])].flatMap((item) => {
    if (item.kind !== 'file') return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

export function hasDraggedImageFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files.length > 0) {
    return [...dataTransfer.files].some(isDraggedImageFile)
  }
  return [...(dataTransfer.items ?? [])].some(
    (item) => item.kind === 'file' && item.type !== 'image/svg+xml' && item.type.startsWith('image/')
  )
}

export function draggedImageFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  return draggedFiles(dataTransfer).filter(isDraggedImageFile)
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
    acceptAnyWorkspaceFileDrag?: boolean
    bashMode?: boolean
    internalDragging?: boolean
  }
): ComposerDragKind | null {
  if (!options.editable || options.disabled || options.internalDragging) return null
  const data = event.dataTransfer
  if (!data) return null

  const workspaceFile = activeFileDrag(event)
  if (workspaceFile) {
    return options.acceptAnyWorkspaceFileDrag || workspaceFile.cwd === options.cwd ? 'files' : null
  }

  if (data.types.includes('Files')) {
    return 'files'
  }

  if (data.types.includes('text/plain')) {
    return 'text'
  }

  return null
}
