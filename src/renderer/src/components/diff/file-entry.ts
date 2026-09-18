/**
 * Presentation shared by the review panel and a diff tab: the status letter, the file icon and the
 * path split have to look the same in both, so they live here instead of in either component.
 */
import {
  File,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  type LucideIcon
} from 'lucide-react'
import type { DiffFileEntry, DiffFileStatus } from '../../ipc/api'

export const STATUS_META: Record<DiffFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: 'A', className: 'text-success', label: '新增' },
  modified: { letter: 'M', className: 'text-warning', label: '修改' },
  deleted: { letter: 'D', className: 'text-destructive', label: '删除' },
  renamed: { letter: 'R', className: 'text-info', label: '重命名' },
  untracked: { letter: 'U', className: 'text-muted-foreground', label: '未跟踪' },
  conflicted: { letter: '!', className: 'text-destructive', label: '冲突' }
}

const ICONS: Record<string, LucideIcon> = {
  json: FileJson,
  json5: FileJson,
  jsonc: FileJson,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  rst: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  avif: FileImage,
  svg: FileImage,
  ico: FileImage,
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  ps1: FileTerminal,
  yml: FileCog,
  yaml: FileCog,
  toml: FileCog,
  ini: FileCog,
  conf: FileCog,
  lock: FileLock,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  vue: FileCode,
  svelte: FileCode,
  astro: FileCode,
  py: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cc: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cs: FileCode,
  php: FileCode,
  css: FileCode,
  scss: FileCode,
  less: FileCode,
  html: FileCode,
  sql: FileCode
}

export function fileIcon(path: string): LucideIcon {
  const base = path.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return File
  return ICONS[base.slice(dot + 1).toLowerCase()] ?? File
}

export function splitPath(path: string): { name: string; directory: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1
    ? { name: path, directory: '' }
    : { name: path.slice(cut + 1), directory: path.slice(0, cut) }
}

/** Line totals for a group header, where a count can be unknown for binary files. */
export function sumCounts(entries: DiffFileEntry[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const entry of entries) {
    additions += entry.additions ?? 0
    deletions += entry.deletions ?? 0
  }
  return { additions, deletions }
}
