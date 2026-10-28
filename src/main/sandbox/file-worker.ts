/** Executes one built-in file tool inside the OS sandbox; never loads sessions or user extensions. */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const input = JSON.parse(readFileSync(0, 'utf8')) as {
  name: string; cwd: string; params: Record<string, unknown>; runtime: { agentDir: string }
}
if (!input.runtime || typeof input.runtime.agentDir !== 'string' || !isAbsolute(input.runtime.agentDir)) {
  throw new Error('Invalid sandboxed file runtime')
}
// Only the trusted host supplies runtime configuration, separately from user/tool parameters. Set
// this before importing SDK modules: tools-manager captures its managed-bin directory at import.
process.env.PI_CODING_AGENT_DIR = input.runtime.agentDir
// Search tools must be installed beforehand. Do not download into (or reopen) the credentials tree.
process.env.PI_OFFLINE = '1'
console.log = console.error
console.info = console.error
const sdk = await import('@earendil-works/pi-coding-agent')
const definitions = {
  read: sdk.createReadToolDefinition, write: sdk.createWriteToolDefinition, edit: sdk.createEditToolDefinition,
  grep: sdk.createGrepToolDefinition, find: sdk.createFindToolDefinition, ls: sdk.createLsToolDefinition
}
if (!Object.hasOwn(definitions, input.name) || typeof input.cwd !== 'string') throw new Error('Invalid sandboxed file operation')
if (input.name === 'grep' || input.name === 'find') {
  const managerPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'utils/tools-manager.js')
  const { getToolPath } = await import(pathToFileURL(managerPath).href) as { getToolPath(name: string): string | null }
  const binary = input.name === 'grep' ? 'rg' : 'fd'
  if (!getToolPath(binary)) throw new Error(`Sandboxed search requires ${binary}. Install ripgrep/fd on PATH or in ${join(input.runtime.agentDir, 'bin')}; automatic downloads are disabled in file workers.`)
}
const tool = definitions[input.name as keyof typeof definitions](input.cwd)
const result = await tool.execute('file', input.params as never, undefined, undefined, { cwd: input.cwd } as never)
process.stdout.write(JSON.stringify(result))
