/**
 * Pi 1.1 exposes the extension factory, but not its config validator, OAuth store or management
 * connection. Keep that version-sensitive access here and reuse Pi's implementation, not another
 * MCP client. The same adapter is exercised by the SDK smoke test.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { pigDir, pigPath } from '../pig-dir'
import { assertMcpAuthCurrent, mcpAuthGeneration } from './connections'

type Runtime =
  typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js')
type Config =
  typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js')
type Core =
  typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js')
type Theme =
  typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js')
type Auth =
  typeof import('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js')
export function sdkFile(relative: string): string {
  return join(
    dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
    relative
  )
}
export type McpConnection = InstanceType<Runtime['McpServerConnection']>
type SdkModules = { runtime: Runtime; config: Config; core: Core; theme: Theme; auth: Auth }
let loaded: Promise<SdkModules> | undefined
export function mcpSdk(): Promise<SdkModules> {
  return (loaded ??= Promise.all([
    import(pathToFileURL(sdkFile('extensions/mcp/runtime.js')).href),
    import(pathToFileURL(sdkFile('extensions/mcp/config.js')).href),
    import(pathToFileURL(sdkFile('core/mcp-servers.js')).href),
    import(pathToFileURL(sdkFile('modes/interactive/theme/theme.js')).href),
    import(pathToFileURL(sdkFile('core/auth-storage.js')).href)
  ]).then(([runtime, config, core, theme, auth]) => ({ runtime, config, core, theme, auth })))
}

export function privateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}
export function readJson(path: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}
let credentialStore: InstanceType<Runtime['McpOAuthCredentialStore']> | undefined
let credentialDirectory: string | undefined
export async function mcpCredentials() {
  const directory = pigDir()
  if (!credentialStore || credentialDirectory !== directory) {
    const { runtime, auth } = await mcpSdk()
    credentialDirectory = directory
    class PigCredentialStore extends runtime.McpOAuthCredentialStore {
      override forServer(name: string, url: string) {
        const store = super.forServer(name, url)
        const generation = mcpAuthGeneration(name)
        return {
          ...store,
          load: () => {
            assertMcpAuthCurrent(name, generation)
            return store.load()
          },
          save: (state: Parameters<typeof store.save>[0]) => {
            assertMcpAuthCurrent(name, generation)
            return store.save(state)
          }
        }
      }
    }
    credentialStore = new PigCredentialStore(
      new auth.FileAuthStorageBackend(pigPath('mcp-auth.json')),
      directory
    )
  }
  return credentialStore
}
