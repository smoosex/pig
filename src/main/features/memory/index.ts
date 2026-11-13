/** Registers on-demand file memory without overriding Pi's session compaction. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerLongTermMemory } from './long-term/extension'

export default async function fileMemory(pi: ExtensionAPI): Promise<void> {
  await registerLongTermMemory(pi)
}
