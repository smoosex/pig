/**
 * Pig's default identity: replaces Pi's identity line whenever the persona plugin has not already
 * written the `preamble` section — no SOUL, or the plugin is off for this session. Sections are rebuilt
 * every run, so a set `preamble` can only come from the persona plugin and extension order does not matter.
 *
 * IDENTIFY's name and USER.md still come from Pig's persona files; errors in them surface loudly, the
 * same as in the persona plugin.
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { userInfo } from 'node:os'
import { parseDocuments, readDocuments } from '../plugins/pi-persona/documents'
import { DEFAULT_PERSONA_NAME, defaultPreamble } from '../plugins/pi-persona/preamble'
import { personaDir } from '../plugins/pi-persona/storage'

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export const pigIdentityExtension: ExtensionFactory = (pi) => {
  pi.on('before_agent_start', async (event) => {
    const options = event.systemPromptOptions
    // A custom prompt (SYSTEM.md) already owns the preamble.
    if (options.customPrompt || options.sections.preamble) return
    const soul = parseDocuments(await readDocuments(personaDir()))
    options.sections.preamble = defaultPreamble({
      name: soul.name ?? DEFAULT_PERSONA_NAME,
      owner: userInfo().username,
      os: OS_NAMES[process.platform] ?? process.platform,
      userProfile: soul.userProfile,
      now: new Date(),
    })
  })
}
