/**
 * Pig's default identity: replaces Pi's identity line whenever the built-in persona has not already
 * written the `preamble` section — no active SOUL. Sections are rebuilt
 * every run, and persona takes precedence regardless of registration order.
 *
 * USER.md still comes from Pig's persona files; document errors surface loudly, the
 * same as in the built-in persona.
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { userInfo } from 'node:os'
import { parseDocuments, readDocuments } from '../features/persona/documents'
import { defaultPreamble } from '../features/persona/preamble'
import { personaDir } from '../features/persona/storage'

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export const pigIdentityExtension: ExtensionFactory = (pi) => {
  pi.on('before_agent_start', async (event) => {
    const options = event.systemPromptOptions
    // A custom prompt (SYSTEM.md) already owns the preamble.
    if (options.customPrompt || options.sections.preamble) return
    const soul = parseDocuments(await readDocuments(personaDir()))
    options.sections.preamble = defaultPreamble({
      owner: userInfo().username,
      os: OS_NAMES[process.platform] ?? process.platform,
      userProfile: soul.userProfile,
      now: new Date(),
    })
  })
}
