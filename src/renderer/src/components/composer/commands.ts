import type { MessageKey } from '../../../../shared/i18n'
import type { SlashCommand } from '../../ipc/api'

export const slashGroups = {
  builtin: { order: 0, labelKey: 'commands.builtin' },
  prompt: { order: 1, labelKey: 'commands.prompt' },
  extension: { order: 2, labelKey: 'commands.extension' },
  skill: { order: 3, labelKey: 'commands.skill' }
} satisfies Record<SlashCommand['source'], { order: number; labelKey: MessageKey }>

export function slashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  return /\s/.test(rest) ? null : rest
}

export function filterSlashCommands(commands: SlashCommand[], query: string | null): SlashCommand[] {
  if (query === null) return []
  const q = query.toLowerCase()
  return commands
    .filter((command) => command.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aHit = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bHit = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return slashGroups[a.source].order - slashGroups[b.source].order || aHit - bHit || a.name.localeCompare(b.name)
    })
}

export function exportPathArg(text: string): string | undefined {
  if (!text.startsWith('/export ')) return undefined
  const rest = text.slice(8).trim()
  if (!rest) return undefined
  const quote = rest[0]
  if ((quote === '"' || quote === "'") && rest.endsWith(quote) && rest.length >= 2) {
    return rest.slice(1, -1)
  }
  return rest
}
