/* Strict document parsing, used for both settings edits and extension prompt injection. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import matter from 'gray-matter'
import { PERSONA_FILES, type PersonaDocument } from '../../../shared/persona'
import { DEFAULT_TRAITS, type SoulDefinition } from './types'
import { readOptional } from './storage'

export const MAX_DOCUMENT_BYTES = 256 * 1024

export function revision(content: string | null): string | null {
  return content === null ? null : createHash('sha256').update(content).digest('hex')
}

export async function readDocuments(dir: string): Promise<PersonaDocument[]> {
  return Promise.all(PERSONA_FILES.map(async name => {
    const content = await readOptional(join(dir, name))
    return { name, content: content ?? '', revision: revision(content) }
  }))
}

export const DEFAULT_SOUL: SoulDefinition = {
  emoji: '󰊠',
  traits: { ...DEFAULT_TRAITS }, systemPrompt: '',
}

export function parseDocuments(files: PersonaDocument[]): SoulDefinition | null {
  const parsed = new Map(files.map(file => {
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new Error(`Persona document ${file.name} exceeds the 256 KiB limit`)
    }
    // gray-matter strips a leading BOM before choosing an engine; validate the same text.
    const content = file.content.replace(/^\uFEFF/, '')
    if (/^---(?!-)/.test(content) && !/^---(?:\r?\n|$)/.test(content)) {
      throw new Error(`Only YAML frontmatter is supported in ${file.name}`)
    }
    if (/^---(?:\r?\n|$)/.test(content) && !/^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.test(content)) {
      throw new Error(`Unterminated persona frontmatter in ${file.name}`)
    }
    const result = matter(content, {
      language: 'yaml',
      engines: { javascript: () => { throw new Error('Executable persona frontmatter is forbidden') } }
    })
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw new Error(`Invalid persona metadata in ${file.name}`)
    }
    return [file.name, result] as const
  }))
  const metadata = parsed.get('IDENTIFY.md')!.data as Record<string, unknown>
  const traits = { ...DEFAULT_TRAITS }
  for (const key of Object.keys(traits) as (keyof typeof traits)[]) {
    const value = metadata[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`IDENTIFY.md trait ${key} must be a number between 0 and 1`)
    }
    traits[key] = value
  }
  for (const key of ['name', 'emoji', 'description']) {
    const value = metadata[key]
    if (value !== undefined && (typeof value !== 'string' || (key !== 'description' && !value.trim()))) {
      throw new Error(`IDENTIFY.md metadata ${key} must be ${key === 'description' ? 'a string' : 'a nonempty string'}`)
    }
  }
  const systemPrompt = parsed.get('SOUL.md')!.content.trim()
  if (!systemPrompt) return null
  const userProfile = parsed.get('USER.md')!.content.trim()
  return {
    ...(metadata.name !== undefined ? { name: (metadata.name as string).trim() } : {}),
    emoji: metadata.emoji as string ?? DEFAULT_SOUL.emoji,
    ...(metadata.description !== undefined ? { description: (metadata.description as string).trim() } : {}),
    traits, systemPrompt, ...(userProfile ? { userProfile } : {}),
  }
}
