/* Strict document parsing, used for both settings edits and extension prompt injection. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import matter from 'gray-matter'
import { PERSONA_FILES, type PersonaDocument } from '../../../shared/persona'
import type { SoulDefinition } from './types'
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

/** An empty `systemPrompt` means no SOUL; USER still applies to the default identity. */
export function parseDocuments(files: PersonaDocument[]): SoulDefinition {
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
  const systemPrompt = parsed.get('SOUL.md')!.content.trim()
  const userProfile = parsed.get('USER.md')!.content.trim()
  return {
    systemPrompt, ...(userProfile ? { userProfile } : {}),
  }
}
