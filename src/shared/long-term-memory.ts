/** File-backed associative memory; Markdown is the only content source. */
export interface LongTermSettings { enabled: boolean }
export type MemoryScope = 'global' | 'project'
export interface MemoryFile { path: string; revision: string; content: string }
export interface MemoryFileListItem { path: string; bytes: number; projectName?: string }
export interface MemoryReadResult {
  files?: { path: string; bytes: number }[]
  file?: MemoryFile
  nextOffset?: number | null
  matches?: { path: string; line: number; text: string }[]
  truncated?: boolean
}
export interface LongTermMemoryApi {
  list(): Promise<MemoryFileListItem[]>
  read(path: string): Promise<MemoryFile>
  save(path: string, content: string, revision: string): Promise<MemoryFile>
  delete(path: string, revision: string): Promise<void>
}
