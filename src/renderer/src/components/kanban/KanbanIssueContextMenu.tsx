/**
 * Right-click context menu for Kanban cards and list rows:
 * Adjust Status, Priority, Labels (multi-toggle + inline create), and Project directly without opening the modal.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Box, Inbox, Plus, Tag } from 'lucide-react'
import { toast } from 'sonner'
import {
  KANBAN_DEFAULT_LABELS,
  KANBAN_PRIORITIES,
  KANBAN_STATUSES,
  type KanbanIssue,
  type KanbanPriority,
  type KanbanStatus,
  type KanbanUpdateInput
} from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { isComposingKey } from '../../lib/shortcuts'
import { useKanbanStore } from '../../stores/kanban'
import { useSessionsStore } from '../../stores/sessions'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '../ui/context-menu'
import { KanbanLabelDot, KanbanPriorityIcon, KanbanStatusIcon } from './kanban-icons'

export function KanbanIssueContextMenu({
  issue,
  disabled = false,
  children
}: {
  issue: KanbanIssue
  disabled?: boolean
  children: ReactNode
}) {
  const t = useT()
  const items = useKanbanStore((s) => s.items)
  const updateIssue = useKanbanStore((s) => s.updateIssue)
  const projects = useSessionsStore((s) => s.projects)
  const [labelQuery, setLabelQuery] = useState('')

  const projectOptions = useMemo(() => {
    const list = projects.map((p) => ({ cwd: p.cwd, name: p.name || baseName(p.cwd) }))
    if (issue.projectCwd && !list.some((p) => p.cwd === issue.projectCwd)) {
      list.unshift({
        cwd: issue.projectCwd,
        name: `${baseName(issue.projectCwd)} (${t('kanban.unopenedProject')})`
      })
    }
    return list
  }, [projects, issue.projectCwd, t])

  const allKnownLabels = useMemo(() => {
    const seen = new Map<string, string>()
    for (const preset of KANBAN_DEFAULT_LABELS) {
      seen.set(preset.toLowerCase(), preset)
    }
    for (const item of items) {
      for (const l of item.labels) {
        const key = l.toLowerCase()
        if (!seen.has(key)) seen.set(key, l)
      }
    }
    for (const l of issue.labels) {
      const key = l.toLowerCase()
      if (!seen.has(key)) seen.set(key, l)
    }
    return [...seen.values()]
  }, [items, issue.labels])

  const filteredLabelOptions = useMemo(() => {
    const q = labelQuery.trim().toLowerCase()
    if (!q) return allKnownLabels
    return allKnownLabels.filter((l) => l.toLowerCase().includes(q))
  }, [allKnownLabels, labelQuery])

  const exactLabelExists = useMemo(() => {
    const q = labelQuery.trim().toLowerCase()
    if (!q) return true
    return allKnownLabels.some((l) => l.toLowerCase() === q)
  }, [allKnownLabels, labelQuery])

  const applyPatch = (patch: Omit<KanbanUpdateInput, 'number'>) => {
    void updateIssue({ number: issue.number, ...patch }).catch((err) =>
      toast.error(failureMessage(err))
    )
  }

  const toggleLabel = (raw: string) => {
    const clean = raw.trim()
    if (!clean) return
    const lower = clean.toLowerCase()
    const exists = issue.labels.some((l) => l.toLowerCase() === lower)
    const nextLabels = exists
      ? issue.labels.filter((l) => l.toLowerCase() !== lower)
      : [...issue.labels, clean]
    applyPatch({ labels: nextLabels })
  }

  const createCustomLabel = () => {
    const clean = labelQuery.trim()
    if (!clean) return
    const lower = clean.toLowerCase()
    if (!issue.labels.some((l) => l.toLowerCase() === lower)) {
      applyPatch({ labels: [...issue.labels, clean] })
    }
    setLabelQuery('')
  }

  return (
    <ContextMenu onOpenChange={(open) => { if (!open) setLabelQuery('') }}>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {/* Status */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <KanbanStatusIcon status={issue.status} className="size-3.5" />
            <span>{t('kanban.fields.status')}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-40">
            <ContextMenuRadioGroup
              value={issue.status}
              onValueChange={(next) => applyPatch({ status: next as KanbanStatus })}
            >
              {KANBAN_STATUSES.map((s) => (
                <ContextMenuRadioItem key={s} value={s}>
                  <KanbanStatusIcon status={s} className="size-3.5" />
                  <span>{t(`kanban.status.${s}`)}</span>
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>

        {/* Priority */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <KanbanPriorityIcon priority={issue.priority} className="size-3.5" />
            <span>{t('kanban.fields.priority')}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-40">
            <ContextMenuRadioGroup
              value={issue.priority}
              onValueChange={(next) => applyPatch({ priority: next as KanbanPriority })}
            >
              {KANBAN_PRIORITIES.map((p) => (
                <ContextMenuRadioItem key={p} value={p}>
                  <KanbanPriorityIcon priority={p} className="size-3.5" />
                  <span>{t(`kanban.priority.${p}`)}</span>
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>

        {/* Labels */}
        <ContextMenuSub onOpenChange={(open) => { if (!open) setLabelQuery('') }}>
          <ContextMenuSubTrigger>
            <Tag className="size-3.5 text-muted-foreground" />
            <span>{t('kanban.fields.labels')}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52 p-1">
            <div className="mb-1 border-b border-glass-border px-2 py-1.5 solid:border-border">
              <input
                type="text"
                value={labelQuery}
                onChange={(e) => setLabelQuery(e.currentTarget.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (isComposingKey(e.nativeEvent)) {
                    e.stopPropagation()
                    return
                  }
                  if (e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp') return
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (!exactLabelExists) createCustomLabel()
                    else if (filteredLabelOptions.length > 0) toggleLabel(filteredLabelOptions[0])
                  }
                }}
                placeholder={t('kanban.fields.labelsPlaceholder')}
                className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/65"
              />
            </div>
            <div className="max-h-52 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {filteredLabelOptions.map((option) => {
                const checked = issue.labels.some((l) => l.toLowerCase() === option.toLowerCase())
                return (
                  <ContextMenuCheckboxItem
                    key={option}
                    checked={checked}
                    onSelect={(e) => {
                      e.preventDefault()
                      toggleLabel(option)
                    }}
                  >
                    <KanbanLabelDot label={option} className="size-2.5" />
                    <span className="truncate">{option}</span>
                  </ContextMenuCheckboxItem>
                )
              })}
              {!exactLabelExists && labelQuery.trim() ? (
                <ContextMenuItem
                  onSelect={(e) => {
                    e.preventDefault()
                    createCustomLabel()
                  }}
                >
                  <Plus className="size-3.5 text-muted-foreground" />
                  <span className="shrink-0 text-muted-foreground">{t('kanban.createLabel')}</span>
                  <KanbanLabelDot label={labelQuery.trim()} className="size-2.5" />
                  <span className="truncate font-medium">{labelQuery.trim()}</span>
                </ContextMenuItem>
              ) : null}
            </div>
          </ContextMenuSubContent>
        </ContextMenuSub>

        {/* Project */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Box className="size-3.5 text-muted-foreground" />
            <span>{t('kanban.fields.project')}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-64 min-w-44 overflow-y-auto">
            <ContextMenuRadioGroup
              value={issue.projectCwd ?? ''}
              onValueChange={(next) => applyPatch({ projectCwd: next || null })}
            >
              <ContextMenuRadioItem value="">
                <Inbox className="size-3.5 text-muted-foreground" />
                <span>{t('kanban.unassigned')}</span>
              </ContextMenuRadioItem>
              {projectOptions.map((proj) => (
                <ContextMenuRadioItem key={proj.cwd} value={proj.cwd}>
                  <Box className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{proj.name}</span>
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
}
