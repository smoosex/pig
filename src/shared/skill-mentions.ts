/**
 * Skill commands inserted as chips in the composer (`/skill:<name>`), plus helpers to recognize
 * Pi's expanded `<skill name="..." location="...">...</skill>` blocks in persisted history.
 */
export interface SkillMention {
  name: string
  start: number
  end: number
}

export interface ExpandedSkillPrompt {
  name: string
  location: string
  body: string
  userMessage?: string
}

export const SKILL_COMMAND_PREFIX = 'skill:'

export function skillCommandName(commandName: string): string | null {
  if (!commandName.startsWith(SKILL_COMMAND_PREFIX)) return null
  const name = commandName.slice(SKILL_COMMAND_PREFIX.length)
  return name.length > 0 && !/\s/.test(name) ? name : null
}

export function skillMentionText(name: string): string {
  return `/skill:${name}`
}

export function isSkillMentionShape(value: unknown): value is SkillMention {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SkillMention>
  return typeof item.name === 'string' && item.name.length > 0 && !/\s/.test(item.name) &&
    Number.isInteger(item.start) && item.start! >= 0 &&
    Number.isInteger(item.end) && item.end! > item.start!
}

export function isSkillMentionAt(content: string, mention: SkillMention): boolean {
  return content.slice(mention.start, mention.end) === skillMentionText(mention.name)
}

/**
 * Matches Pi's `_expandSkillCommand` output (`<skill name="..." location="...">\n...\n</skill>`).
 * Uses a greedy body match so example `</skill>` tags inside a skill's own markdown do not cut early.
 */
export function parseExpandedSkillPrompt(text: string): ExpandedSkillPrompt | null {
  if (!text.startsWith('<skill name="')) return null
  const match = /^<skill name="([^"\n]+)" location="([^"\n]+)">\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text)
  if (!match) return null
  const userMessage = match[4]?.trim()
  return {
    name: match[1],
    location: match[2],
    body: match[3],
    ...(userMessage ? { userMessage } : {})
  }
}

export function parseLeadingSkillCommand(text: string): { name: string; commandText: string; rest: string } | null {
  if (!text.startsWith('/skill:')) return null
  const match = /^\/skill:([^\s/]+)(?=$|\s)([\s\S]*)$/.exec(text)
  if (!match) return null
  const name = match[1]
  return {
    name,
    commandText: skillMentionText(name),
    rest: match[2]
  }
}

export function formatExpandedSkillPreview(expanded: Pick<ExpandedSkillPrompt, 'name' | 'userMessage'>): string {
  const command = skillMentionText(expanded.name)
  return expanded.userMessage ? `${command} ${expanded.userMessage}` : command
}
