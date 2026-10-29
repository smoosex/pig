/**
 * The subagent section of a reply's usage popover. Children are attributed to the user turn that
 * spawned them, so background work finishing after the reply still counts here. Their usage stays
 * out of the turn's own figures: other models and caches would distort its hit rate and call count.
 */
import { useEffect, useMemo } from 'react'
import type { TurnUsage } from '../../../../shared/api'
import { useT } from '../../hooks/useT'
import { useSubagentStore } from '../../stores/subagents'
import { UsageRows, useUsageFormat } from '../turn/UsagePopover'

export function TurnSubagentUsage({ sessionId, turnId, usage }: { sessionId: string; turnId: string; usage: TurnUsage }) {
  const t = useT()
  const { numbers } = useUsageFormat()
  const ensure = useSubagentStore((state) => state.ensure)
  const all = useSubagentStore((state) => state.bySession[sessionId])
  useEffect(() => ensure(sessionId), [ensure, sessionId])
  const items = useMemo(() => (all ?? []).filter((item) => item.parentTurnId === turnId), [all, turnId])
  if (!items.length) return null
  const childTotal = items.reduce((sum, item) => sum + (item.usage?.total ?? 0), 0)
  const rows: Array<[string, string]> = [
    ...items.map((item): [string, string] => [item.title, item.usage ? numbers.format(item.usage.total) : '—']),
    [t('subagents.usageTotal'), numbers.format(childTotal)],
    [t('subagents.usageWithMain'), numbers.format(usage.total + childTotal)]
  ]
  return (
    <>
      <p className="mt-1.5 border-t border-border pt-2.5 font-medium text-muted-foreground">
        {t('subagents.usageSection', { n: items.length })}
      </p>
      <UsageRows rows={rows} />
    </>
  )
}
