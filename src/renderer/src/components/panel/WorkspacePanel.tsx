/**
 * The right column: a worktree's files and its changes, one of the two at a time. A shared pill follows
 * the selected icon as its label expands; the active changes label also carries the changed-file count.
 *
 * It shares the left sidebar's fixed width and keeps its contents mounted while the outer rail collapses
 * to zero. The inner rail stays full width, so collapsing either sidebar does not reflow its rows.
 *
 * The worktree watch belongs to the column rather than to the 变更 view: the file tree is refreshed from
 * the same events, and it runs only while the column is open.
 */
import { useEffect, useId } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Files, FileDiff } from 'lucide-react'
import { retainWorktreeWatch, useDiffStore, type PanelTab } from '../../stores/diff'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { FileTree } from '../files/FileTree'
import { ChangesPanel } from '../diff/ChangesPanel'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'


export function WorkspacePanel({ cwd, hidden = false, floating = false }: { cwd: string; hidden?: boolean; floating?: boolean }) {
  const t = useT()
  const switchId = useId()
  const reduced = useReducedMotion()
  const tab = useDiffStore((s) => s.panelTab[cwd] ?? 'changes')
  const setPanelTab = useDiffStore((s) => s.setPanelTab)
  const changed = useDiffStore((s) => s.worktrees[cwd]?.diff?.all.length ?? null)

  useEffect(() => {
    if (hidden) return
    return retainWorktreeWatch(cwd)
  }, [cwd, hidden])

  return (
    <aside
      inert={hidden}
      aria-hidden={hidden}
      className={cn(
        'flex min-w-0 overflow-hidden bg-transparent solid:bg-sidebar text-sidebar-foreground duration-200 ease-in-out motion-reduce:transition-none',
        floating && hidden ? 'transition-[background-color]' : 'transition-[width,background-color]',
        hidden ? 'w-0' : 'w-62'
      )}
    >
      <div className="flex w-62 shrink-0 flex-col pr-2">
        <header className="mb-1 flex h-9 shrink-0 items-center justify-center gap-2 pr-1 pl-1.5 whitespace-nowrap">
          <ToggleGroup
            type="single"
            size="xs"
            value={tab}
            onValueChange={(value) => value && setPanelTab(cwd, value as PanelTab)}
            aria-label={t('panel.viewAria')}
          >
            {(['files', 'changes'] as const).map(value => {
              const active = value === tab
              const Icon = value === 'files' ? Files : FileDiff
              return <ToggleGroupItem key={value} value={value} aria-label={t(`panel.${value}`)} title={t(`panel.${value}`)}
                className="relative gap-0 rounded-full px-2 font-normal data-[state=on]:bg-transparent! solid:data-[state=on]:bg-transparent! solid:data-[state=on]:text-sidebar-foreground">
                {active ? <motion.span layoutId={switchId} data-panel-pill aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full border border-glass-button-border bg-glass-button-background bg-[image:var(--glass-button-sheen)] shadow-glass-button solid:border-border solid:bg-sidebar-accent solid:bg-none solid:shadow-none"
                  transition={reduced ? { duration: 0 } : { type: 'spring', visualDuration: 0.25, bounce: 0 }} /> : null}
                <Icon className="relative" />
                <motion.span initial={false} animate={{ width: active ? 'auto' : 0, opacity: active ? 1 : 0 }}
                  transition={{ duration: reduced ? 0 : 0.2, ease: 'easeInOut' }} className="relative overflow-hidden">
                  <span className="flex items-center gap-1.5 pl-1.5">
                    {t(`panel.${value}`)}
                    {value === 'changes' && changed !== null ? <span className="text-xs text-muted-foreground tabular-nums">{changed}</span> : null}
                  </span>
                </motion.span>
              </ToggleGroupItem>
            })}
          </ToggleGroup>
        </header>

        {tab === 'files' ? <FileTree cwd={cwd} /> : <ChangesPanel cwd={cwd} />}
      </div>
    </aside>
  )
}
