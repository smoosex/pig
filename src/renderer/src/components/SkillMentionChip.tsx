import { useContext, useRef, useState } from 'react'
import { Check, Copy, WandSparkles } from 'lucide-react'
import { skillCommandName, skillMentionText } from '../../../shared/skill-mentions'
import { api } from '../ipc/api'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { useSessionsStore } from '../stores/sessions'
import { FileMentionContext } from './FileMentionChip'
import { INLINE_CHIP_CLASS } from './inline-chip'
import { Button } from './ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card'

const SKILL_CHIP_CLASS =
  'border-chart-4/30 bg-chart-4/10 text-chart-4 hover:border-chart-4/45 hover:bg-chart-4/16 aria-expanded:border-chart-4/45 aria-expanded:bg-chart-4/16 solid:border-chart-4/30 solid:bg-chart-4/10 solid:text-chart-4 solid:hover:border-chart-4/45 solid:hover:bg-chart-4/16 solid:aria-expanded:border-chart-4/45 solid:aria-expanded:bg-chart-4/16 solid:aria-expanded:text-chart-4'

function worktreeRelativePath(cwd: string | null, filePath: string | undefined): string | null {
  if (!cwd || !filePath) return null
  const root = cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const normalized = filePath.replace(/\\/g, '/')
  const prefix = root === '' ? '/' : `${root}/`
  return normalized.startsWith(prefix) && normalized.length > prefix.length
    ? normalized.slice(prefix.length)
    : null
}

/**
 * Inline chip for a `/skill:<name>` invocation in the composer and in sent user bubbles.
 * Shares `INLINE_CHIP_CLASS` metrics with `FileMentionChip` while carrying the `--chart-4` skill accent.
 */
export function SkillMentionChip({
  name,
  description,
  location,
  opensSkill = false,
  className
}: {
  name: string
  description?: string
  location?: string
  opensSkill?: boolean
  className?: string
}) {
  const t = useT()
  const { cwd, sessionId } = useContext(FileMentionContext)
  const [resolved, setResolved] = useState<{ description?: string; filePath?: string }>({})
  const [copied, setCopied] = useState(false)
  const request = useRef(0)

  const commandText = skillMentionText(name)
  const finalDescription = resolved.description ?? description
  const finalPath = resolved.filePath ?? location
  const relativePath = worktreeRelativePath(cwd, finalPath)

  const load = (open: boolean) => {
    setCopied(false)
    const id = ++request.current
    if (!open) return
    void Promise.allSettled([
      api?.listSkills?.(),
      sessionId ? api?.getCommands?.(sessionId) : Promise.resolve(undefined)
    ]).then(([inventoryResult, commandsResult]) => {
      if (request.current !== id) return
      const fromInventory = inventoryResult.status === 'fulfilled'
        ? inventoryResult.value?.skills.find((skill) => skill.name === name)
        : undefined
      const fromCommands = commandsResult.status === 'fulfilled'
        ? commandsResult.value?.find((cmd) => cmd.source === 'skill' && skillCommandName(cmd.name) === name)
        : undefined
      const nextDescription = fromInventory?.description || fromCommands?.description
      const nextPath = fromInventory?.filePath
      if (nextDescription || nextPath) {
        setResolved({
          ...(nextDescription ? { description: nextDescription } : {}),
          ...(nextPath ? { filePath: nextPath } : {})
        })
      }
    })
  }

  const copy = async () => {
    await navigator.clipboard.writeText(commandText)
    setCopied(true)
  }

  const handleClick = opensSkill
    ? () => {
        if (!cwd) return
        if (relativePath) {
          void useSessionsStore.getState().openFileTab(cwd, relativePath)
          return
        }
        void api?.listSkills?.().then((inventory) => {
          const match = inventory?.skills.find((skill) => skill.name === name)
          const rel = worktreeRelativePath(cwd, match?.filePath)
          if (rel) void useSessionsStore.getState().openFileTab(cwd, rel)
        }, () => {})
      }
    : undefined

  return (
    <HoverCard openDelay={300} closeDelay={100} onOpenChange={load}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          data-skill-mention={name}
          className={cn(INLINE_CHIP_CLASS, SKILL_CHIP_CLASS, className)}
          aria-label={commandText}
          onClick={handleClick}
        >
          <WandSparkles className="size-3.5 shrink-0 text-chart-4" aria-hidden="true" />
          <span className="min-w-0 truncate">{name}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" collisionPadding={12} className="flex w-auto max-w-[min(28rem,calc(100vw-2rem))] min-w-56 flex-col gap-1.5 rounded-xl p-3">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <WandSparkles className="size-3.5 shrink-0 text-chart-4" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium">{name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{commandText}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto shrink-0"
            aria-label={copied ? t('common.copied') : t('skillMention.copyCommand')}
            title={copied ? t('common.copied') : t('skillMention.copyCommand')}
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        {finalDescription ? (
          <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{finalDescription}</p>
        ) : null}
        {finalPath ? (
          <p className="truncate font-mono text-xs text-muted-foreground" title={finalPath}>{finalPath}</p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  )
}
