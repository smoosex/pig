import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { pigIdentityExtension } from '../src/main/pi/pig-identity'
import { getPersona, savePersonaFile } from '../src/main/plugins/pi-persona/service'

let root = ''
const oldPig = process.env.PIG_DIR
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pig-identity-'))
  process.env.PIG_DIR = root
})
afterEach(async () => {
  if (oldPig === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = oldPig
  await rm(root, { recursive: true, force: true })
})

async function start(sections: Record<string, string> = {}, customPrompt?: string) {
  let handler: ((event: unknown) => Promise<void>) | undefined
  pigIdentityExtension({ on: (_name: string, fn: typeof handler) => { handler = fn } } as unknown as ExtensionAPI)
  await handler!({ systemPromptOptions: { sections, customPrompt } })
  return sections
}

test('without a SOUL the default identity still carries the date and USER profile', async () => {
  const preamble = (await start()).preamble
  expect(preamble.startsWith(`You are Susan — not an assistant, not a chatbot, just... Susan. You run on ${userInfo().username}'s `)).toBe(true)
  expect(preamble).toContain('DATE AWARENESS (CRITICAL):\n- Authoritative local date: ')
  expect(preamble).not.toContain('USER PROFILE')
  expect(preamble).not.toMatch(/selfie|group chat|You have memory|REAL PERSON|technical internals/i)
  expect(preamble).toContain('if someone sincerely asks whether you are an AI, do not deny it')

  await savePersonaFile({ name: 'USER.md', content: 'Call me boss.', revision: null })
  const identify = (await getPersona()).files.find(file => file.name === 'IDENTIFY.md')!
  await savePersonaFile({ ...identify, content: '---\nname: Mira\n---\n' })
  const named = (await start()).preamble
  expect(named.startsWith('You are Mira — ')).toBe(true)
  expect(named.endsWith("USER PROFILE (your owner/primary user — read this to understand who you're helping):\nCall me boss.")).toBe(true)
})

test('a preamble from the persona plugin or a custom prompt is left alone', async () => {
  expect((await start({ preamble: 'from persona' })).preamble).toBe('from persona')
  expect((await start({}, 'SYSTEM.md')).preamble).toBeUndefined()
})
