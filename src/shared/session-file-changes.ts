/** Serializable, cumulative successful file operations; not a working-tree or net diff. */
export interface FileChangeOperation {
  id: string
  tool: 'edit' | 'write'
  patch?: string
  diff?: string
  added: number
  removed: number
  unknown: boolean
}

export interface SessionFileChange {
  path: string
  added: number
  removed: number
  unknownOperations: number
  operations: FileChangeOperation[]
}

export interface SessionFileChanges {
  files: SessionFileChange[]
  /** Display turn ids (user and `!cmd` groups), including turns without successful file operations. */
  turns: Record<string, SessionFileChange[]>
}
