/**
 * Replaces the SDK's `docs` section with one that first explains where Pig keeps configuration.
 *
 * The default section is written for the pi CLI and points agents at `~/.pi/agent`, while Pig owns
 * most of its configuration in its own data directory and shares only a few files with the CLI. A
 * custom section with the same name replaces the default in place, so it stays at the same position
 * and, with unchanged paths, renders identical text every run.
 */
import { getAgentDir, getDocsPath, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { pigDir } from '../pig-dir'

const DOCS = /(?:^|\n)<docs>\n([\s\S]*?)\n<\/docs>(?:\n|$)/

export function pigDocsNote(): string {
  const pig = pigDir()
  const agent = getAgentDir()
  const lines = [
    "You are running inside Pig, a desktop app built on the pi SDK. The pi documentation below describes the SDK and the pi CLI; Pig manages configuration differently:",
    `- Pig's data directory for this install is ${pig}, owned by Pig alone: settings.json (Pig's app settings, not pi's), mcp.json and mcp-auth.json, plugins.json and plugin-settings/, web-search.json, subagent-settings.json, skills.json and imported skills/, persona/, chats/, worktrees/, terminals/, browser-history.json, permissions.json and session-permissions/.`,
    `- Shared with the pi CLI, so changes affect both: ${join(agent, 'auth.json')} (sign-in), ${join(agent, 'sessions')} (session files), ${join(agent, 'skills')} (read-only for Pig), and the default model, default thinking level, modelThinkingLevels and enabledModels in ${join(agent, 'settings.json')}.`,
    "- Pig ignores pi packages and extensions (the packages setting, the extensions directories, `pi install`); plugins and MCP servers are managed in Pig's settings."
  ]
  if (getDocsPath().includes('.asar')) {
    lines.push('- The pi docs are inside app.asar: open them with the read tool, shell commands cannot read files there.')
  }
  return lines.join('\n')
}

export const pigDocsExtension: ExtensionFactory = (pi) => {
  pi.on('before_agent_start', (event) => {
    const options = event.systemPromptOptions
    // A custom prompt (SYSTEM.md) drops the default docs section; adding one would only append it.
    if (options.customPrompt) return
    const docs = DOCS.exec(event.systemPrompt)?.[1]
    if (docs === undefined) throw new Error('The pi system prompt has no docs section to extend')
    options.sections.docs = `${pigDocsNote()}\n\n${docs}`
  })
}
