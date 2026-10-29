/** Text the parent model receives about a subagent: foreground tool results and background deliveries share one format. */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from '@earendil-works/pi-coding-agent'
import type { SubagentInfo } from '../../shared/api'

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h${m}m`
  return m ? `${m}m${s}s` : `${s}s`
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export function formatReport(info: SubagentInfo): string {
  const lines = [`[subagent #${info.id}] ${info.title} — ${info.status}`]
  if (info.model) {
    lines.push(`model: ${info.model.provider}/${info.model.id}${info.fallbackReason ? ` (fallback: ${info.fallbackReason})` : ''}`)
  }
  const elapsed = info.startedAt === undefined ? 0 : (info.endedAt ?? Date.now()) - info.startedAt
  const sent = info.usage ? info.usage.input + info.usage.cacheRead + info.usage.cacheWrite : 0
  lines.push(`turns: ${info.turns} · duration: ${duration(elapsed)} · tokens: ${tokens(sent)} in / ${tokens(info.usage?.output ?? 0)} out`)
  if (info.editedFiles.length) lines.push(`edited: ${info.editedFiles.join(', ')}`)
  if (info.error) lines.push(`error: ${info.error}`)

  const output = info.output?.trim()
  if (output) {
    const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES })
    lines.push('', truncated.content)
    if (truncated.truncated) {
      lines.push('', info.sessionFile
        ? `[Report truncated. Full transcript: ${info.sessionFile}]`
        : '[Report truncated.]')
    }
  } else {
    lines.push('', info.status === 'completed' ? '(The subagent ended without a report.)' : '(No report was produced.)')
  }
  return lines.join('\n')
}

export function backgroundAck(info: SubagentInfo, queuePosition: number): string {
  const queued = queuePosition > 0 ? ` (queued: position ${queuePosition})` : ''
  return `Subagent #${info.id} "${info.title}" started in the background${queued}.
Its report will arrive as a subagent-result message. Do not assume its outcome. Continue with other work, or end your turn if there is none.`
}

export function combineReports(items: SubagentInfo[]): string {
  return items.map(formatReport).join('\n\n---\n\n')
}
