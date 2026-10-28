/**
 * The only caller of srt (`@anthropic-ai/sandbox-runtime`). srt is a process-wide singleton: one
 * network proxy and one global host list serve every session, while each wrap carries its session's
 * filesystem rules and a per-command host list. srt's ask callback sees only a host, never which
 * session asked, so Pig registers none: unknown hosts are denied and the session's own bash tool asks
 * after the command, from the violations recorded under that command's id.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SandboxManager, getDefaultWritePaths, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { PermissionMode, SandboxStatus } from '../../shared/permissions'
import { pigDir } from '../pig-dir'
import { projectDomains, readPermissionSettings } from '../permissions/store'
import { DEFAULT_DOMAINS, packageCachePaths, sandboxFilesystem, secretPaths, within, type PathAccess, type PolicyEnvironment, type Workspace } from './policy'
import { finishReadOnly, shutdownReadOnly, wrapReadOnly } from './readonly'
import { sandboxAssets } from './assets'
import { clearSandboxTemporary, sandboxTemporary } from './temporary'
import { realTarget } from './path'
export { realTarget } from './path'
export { sessionWorkspace } from './workspace'

let status: SandboxStatus = { state: 'pending' }
let starting: Promise<SandboxStatus> | undefined
const sessionHosts = new Map<string, Set<string>>()

export function policyEnvironment(): PolicyEnvironment {
  const pig = realTarget(pigDir())
  const credentials = ['NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE', 'KUBECONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'DOCKER_CONFIG', 'CLOUDSDK_CONFIG',
    'GNUPGHOME', 'NETRC'].flatMap((key) => {
    const value = process.env[key]
    return value ? (key === 'KUBECONFIG' ? value.split(process.platform === 'win32' ? ';' : ':') : [value]) : []
  }).filter(Boolean).map((path) => realTarget(path))
  const env: PolicyEnvironment = {
    home: homedir(), pigDir: pig, agentDir: realTarget(getAgentDir()), credentials,
    temporary: [sandboxTemporary(pig)], implicitWrite: getDefaultWritePaths().filter((path) => !path.startsWith('/dev/')).map((path) => realTarget(path))
  }
  env.canonical = Object.fromEntries([...secretPaths(env), join(env.home, '.ssh', 'known_hosts'), join(env.home, '.ssh', 'config'),
    join(env.home, '.pi'), env.agentDir!, ...env.temporary, ...packageCachePaths(env)]
    .map((path) => [path, realTarget(path)]))
  return env
}

function hostList(): string[] {
  return [...new Set([...DEFAULT_DOMAINS, ...readPermissionSettings().domains])]
}

function globalConfig(): SandboxRuntimeConfig {
  const socket = process.env.SSH_AUTH_SOCK
  return {
    ...sandboxAssets(),
    network: {
      allowedDomains: hostList(), deniedDomains: [], allowLocalBinding: true,
      // Git over SSH signs through the agent; the keys themselves stay unreadable.
      ...(socket ? { allowUnixSockets: [socket] } : {})
    },
    filesystem: { denyRead: secretPaths(policyEnvironment()).map((path) => ({ path, literal: true })), allowWrite: [], denyWrite: [] }
  }
}


/**
 * Starts the proxy once. A failure becomes a visible `unavailable` state rather than an exception: the
 * permission layer then confirms every command, which is the only safe way to keep working without
 * a sandbox. Nothing runs unsandboxed on this result alone.
 */
export function ensureSandbox(): Promise<SandboxStatus> {
  if (starting) return starting
  const attempt = (async () => {
    if (process.platform === 'win32' || !SandboxManager.isSupportedPlatform()) return (status = { state: 'unsupported' })
    const dependencies = SandboxManager.checkDependencies()
    if (dependencies.errors.length) return (status = { state: 'unavailable', detail: dependencies.errors.join('; ') })
    // Configuration decoding is not a sandbox availability failure: broken JSON must block, not
    // offer a way around the user's policy by treating it as an OS dependency problem.
    const config = globalConfig()
    try {
      // No macOS log monitor: it reports every benign system denial (sysctl reads by git) into the
      // output. Network refusals come from the proxy and stay attributed to their command.
      await SandboxManager.initialize(config, undefined, false)
      status = { state: 'ready' }
    } catch (error) {
      status = { state: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
    }
    return status
  })()
  starting = attempt
  void attempt.catch(() => { if (starting === attempt) starting = undefined })
  return attempt
}

/** Applies a changed global host list to running commands too; srt reads it per connection. */
export function refreshSandboxHosts(): void {
  const config = SandboxManager.getConfig()
  if (!config) return
  const allowedDomains = hostList()
  if (JSON.stringify(config.network.allowedDomains) !== JSON.stringify(allowedDomains)) {
    SandboxManager.updateConfig({ ...config, network: { ...config.network, allowedDomains } })
  }
}

export function allowSessionHost(sessionId: string, host: string): void {
  const hosts = sessionHosts.get(sessionId) ?? new Set<string>()
  hosts.add(host)
  sessionHosts.set(sessionId, hosts)
}

export function forgetSessionHosts(sessionId: string): void {
  sessionHosts.delete(sessionId)
}

export interface SandboxedCommand {
  /** Run this with `shell -c`. */
  command: string
  /** Unregisters the command's hosts; returns the hosts it was refused and srt's violation report. */
  finish(): { hosts: string[]; report: string }
}

export interface SandboxRequest {
  shell: string
  mode: PermissionMode
  workspace: Workspace
  /** Whose session-allowed hosts apply; a subagent passes its parent. */
  sessionId: string
  signal?: AbortSignal
  /** A single file operation the user approved, never a general command grant. */
  fileGrant?: { target: string; access: PathAccess }
}

const DENIED_HOST = /^deny network-outbound (.+):\d+ \(/

export async function sandboxCommand(command: string, request: SandboxRequest): Promise<SandboxedCommand> {
  request.signal?.throwIfAborted()
  if ((await ensureSandbox()).state !== 'ready') throw new Error('The sandbox is not available')
  refreshSandboxHosts()
  // srt requires at least 128 random bits: the id is what binds a proxy connection to this list.
  const id = randomBytes(16).toString('base64url')
  const env = policyEnvironment()
  const temporary = env.temporary[0].replaceAll("'", "'\\''")
  command = `export TMPDIR='${temporary}' TMP='${temporary}' TEMP='${temporary}'; ${command}`
  const filesystem = sandboxFilesystem(request.mode, request.workspace, env)
  if (request.fileGrant) {
    const { target, access } = request.fileGrant
    filesystem.allowRead.push(target)
    if (access === 'write') {
      filesystem.denyWrite = filesystem.denyWrite.filter((path) => !within(path, target))
      filesystem.allowWrite.push(target)
      for (let parent = dirname(target); !existsSync(parent); parent = dirname(parent)) filesystem.allowWrite.push(parent)
    }
  }
  // User-selected directory names are data, not srt glob expressions (for example `repo[1]`).
  const literal = (paths: string[]) => paths.map((path) => ({ path, literal: true as const }))
  const literalFilesystem: SandboxRuntimeConfig['filesystem'] = {
    denyRead: literal(filesystem.denyRead), allowRead: literal(filesystem.allowRead),
    allowWrite: literal(filesystem.allowWrite), denyWrite: literal(filesystem.denyWrite)
  }
  if (request.mode === 'read-only') {
    const wrapped = await wrapReadOnly(command, request.shell, literalFilesystem, id, request.signal)
    let finished = false
    return { command: wrapped, finish() {
      if (!finished) { finished = true; finishReadOnly(id) }
      return { hosts: [], report: '' }
    } }
  }
  SandboxManager.registerCommandNetworkLists(id, {
    allowedDomains: [...projectDomains(readPermissionSettings(), request.workspace.gitCommonDir), ...(sessionHosts.get(request.sessionId) ?? [])]
  })
  try {
    const wrapped = await SandboxManager.wrapWithSandbox(command, request.shell, {
      filesystem: literalFilesystem
    }, request.signal, { commandId: id, commandText: command })
    return {
      command: wrapped,
      finish() {
        SandboxManager.unregisterCommandNetworkLists(id)
        SandboxManager.cleanupAfterCommand()
        const lines = SandboxManager.getSandboxViolationStore().getViolationsForCommand(id).map((violation) => violation.line)
        const hosts = [...new Set(lines.flatMap((line) => DENIED_HOST.exec(line)?.[1] ?? []))]
        return { hosts, report: SandboxManager.annotateStderrWithSandboxFailures(id, '').trim() }
      }
    }
  } catch (error) {
    SandboxManager.unregisterCommandNetworkLists(id)
    throw error
  }
}

/** Only after sessions and background processes have stopped: live jobs must retain their proxies. */
export async function shutdownSandbox(): Promise<void> {
  const results = await Promise.allSettled([SandboxManager.reset(), shutdownReadOnly()])
  sessionHosts.clear()
  starting = undefined
  status = { state: 'pending' }
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  try { clearSandboxTemporary() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Sandbox cleanup failed')
}
