/** Entry points from the main conversation into the subagent card: spawn tool rows and result messages. */
import { LoaderCircle } from 'lucide-react'
import type { CustomMessage, TextContent } from '../../pi/types'
import type { SubagentResultDetails } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { isSubagentActive, useLocatedSubagent, useSubagentStore, type LocatedSubagent } from '../../stores/subagents'
import { Button } from '../ui/button'
import { SubagentAvatar, SubagentMeta, useNow } from './subagent-view'

function SubagentLine({ located }: { located: LocatedSubagent }) {
  const t = useT()
  const openCard = useSubagentStore((state) => state.openCard)
  const { item, sessionId } = located
  const now = useNow(isSubagentActive(item))
  return (
    <div className="flex min-w-0 items-center gap-2 py-1">
      <SubagentAvatar item={item} className="size-5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{item.title}</span>
        <SubagentMeta item={item} now={now} />
      </span>
      <Button type="button" variant="outline" size="xs" onClick={() => openCard(sessionId, item.id)}>
        {t('subagents.open')}
      </Button>
    </div>
  )
}

/** Body of an expanded spawn tool row. Returns null when the subagent is not in any loaded list. */
export function SpawnToolBody({ toolCallId }: { toolCallId: string }) {
  const located = useLocatedSubagent((item) => item.toolCallId === toolCallId)
  if (!located) return null
  const { item } = located
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2">
      <SubagentLine located={located} />
      {item.status === 'running' && item.activity ? (
        <p className="flex min-w-0 items-center gap-1.5 pl-7 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
          <span className="truncate font-mono">{item.activity}</span>
        </p>
      ) : null}
    </div>
  )
}

function ResultLine({ entry }: { entry: SubagentResultDetails['subagents'][number] }) {
  const t = useT()
  const located = useLocatedSubagent((item) => item.id === entry.id)
  if (located) return <SubagentLine located={located} />
  return <p className="truncate text-sm">{entry.title} · {t(`subagents.status.${entry.status}`)}</p>
}

export function SubagentResultNotice({ message }: { message: CustomMessage }) {
  const t = useT()
  const details = message.details as SubagentResultDetails | undefined
  const entries = Array.isArray(details?.subagents) ? details.subagents : []
  const text = typeof message.content === 'string'
    ? message.content
    : message.content.filter((block): block is TextContent => block.type === 'text').map((block) => block.text).join('')
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <div className="font-medium text-muted-foreground">{t('subagents.result')}</div>
      {entries.map((entry) => <ResultLine key={entry.id} entry={entry} />)}
      {!entries.length && text ? <p className="whitespace-pre-wrap">{text}</p> : null}
    </div>
  )
}
