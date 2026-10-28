/**
 * What sandboxed commands may touch, derived from the session's workspace. Pure, so it is tested
 * without the OS sandbox; the file tools use the same protected lists, so the two layers agree.
 */
import { basename, join, relative, isAbsolute, sep } from 'node:path'
import type { PermissionMode } from '../../shared/permissions'

export interface PolicyEnvironment {
  home: string
  pigDir: string
  /** SDK-resolved directory, including PI_CODING_AGENT_DIR overrides. */
  agentDir?: string
  /** Explicit credential/configuration paths selected by supported toolchain environment variables. */
  credentials?: string[]
  /** srt's implicit writable directories, resolved by the host. */
  implicitWrite?: string[]
  /** Real paths of the temporary directories commands may write. */
  temporary: string[]
  /** Logical protected paths mapped to their physical location, including symlinked credential dirs. */
  canonical?: Record<string, string>
}

/** The session's working directory and its repository's Git common directory, as real paths. */
export interface Workspace {
  cwd: string
  gitCommonDir: string | null
  /** Linked worktree metadata directory; configuration there is separate from the common dir. */
  gitDir?: string
  /** The `.git` entry of a layout Pig does not grant (submodule, separate-git-dir, symlinked path): read-only. */
  gitMetadata?: string
}

/** Package registries and code hosts every sandboxed command may reach. */
export const DEFAULT_DOMAINS = [
  'registry.npmjs.org', 'registry.yarnpkg.com', 'bun.sh',
  'pypi.org', 'files.pythonhosted.org',
  'github.com', '*.github.com', '*.githubusercontent.com',
  'crates.io', '*.crates.io', 'proxy.golang.org', 'sum.golang.org'
]

// Shell startup and Git configuration run code; writes to them are always confirmed.
const STARTUP_FILES = ['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.zshenv', '.profile', '.gitconfig', '.gitmodules']

/** Credentials and Pig's own configuration: unreadable in the sandbox, confirmed for file tools. */
export function secretPaths(env: PolicyEnvironment): string[] {
  const home = (...parts: string[]) => join(env.home, ...parts)
  const paths = [
    home('.ssh'), home('.aws'), home('.gnupg'), home('.netrc'), home('.npmrc'), home('.pypirc'),
    home('.docker'), home('.kube'), home('.config', 'gcloud'), home('.azure'), home('.config', 'gh'),
    home('.git-credentials'), home('.config', 'git', 'credentials'),
    home('Library', 'Keychains'), home('Library', 'Application Support', 'Google', 'Chrome'),
    home('.local', 'share', 'keyrings'), home('.config', 'google-chrome'), home('.config', 'chromium'),
    home('.pi', 'agent', 'auth.json'), join(env.agentDir ?? home('.pi', 'agent'), 'auth.json'),
    join(env.agentDir ?? home('.pi', 'agent'), 'models.json'), ...(env.credentials ?? []), env.pigDir
  ]
  return [...new Set(paths.flatMap((path) => env.canonical?.[path] ? [path, env.canonical[path]] : [path]))]
}

/**
 * Inside a secret directory but needed by ordinary tools (Git over SSH, Pig worktrees and chats). Only
 * a path beneath the secret reopens it: a workspace that merely contains Pig's data directory (Pig's
 * own repository in development) must not expose it.
 */
function reopenedPaths(env: PolicyEnvironment, workspace: Workspace): string[] {
  // Reopen only this task's scratch/worktree, never every project's worktrees or arbitrary secrets
  // just because the user opened one as a workspace. A workspace equal to Pig's directory is unsafe.
  const taskDirectory = ['worktrees', 'chats'].some((kind) => {
    const root = join(env.pigDir, kind)
    return workspace.cwd !== root && within(root, workspace.cwd)
  })
  const paths = [join(env.home, '.ssh', 'known_hosts'), join(env.home, '.ssh', 'config'), ...(taskDirectory ? [workspace.cwd] : [])]
  return paths.flatMap((path) => env.canonical?.[path] ? [path, env.canonical[path]] : [path])
}

export function packageCachePaths(env: PolicyEnvironment): string[] {
  const home = (...parts: string[]) => join(env.home, ...parts)
  return [home('.bun', 'install', 'cache'), home('.npm'), home('.cache'), home('Library', 'Caches'), home('.cargo', 'registry'), home('go', 'pkg', 'mod')]
}

export function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

export function writeRoots(mode: PermissionMode, workspace: Workspace, env: PolicyEnvironment): string[] {
  const roots = mode === 'read-only' ? [...env.temporary] : [workspace.cwd,
    ...(workspace.gitCommonDir && !within(workspace.cwd, workspace.gitCommonDir) ? [workspace.gitCommonDir] : []),
    ...env.temporary, ...packageCachePaths(env)]
  // A task beneath Pig's denied read root needs a write carve-out. Never pair that carve-out with
  // an ancestor allow (notably /tmp or a cache containing PIG_DIR), which would reopen all Pig data.
  return roots.filter((root) => !within(root, env.pigDir) &&
    !Object.entries(env.canonical ?? {}).some(([logical, real]) => logical === root && within(real, env.pigDir)))
}

/** The per-command filesystem part of srt's config; the network part is global. */
export function sandboxFilesystem(mode: PermissionMode, workspace: Workspace, env: PolicyEnvironment) {
  return {
    denyRead: secretPaths(env),
    allowRead: reopenedPaths(env, workspace),
    allowWrite: writeRoots(mode, workspace, env),
    denyWrite: [
      ...secretPaths(env).filter((path) => path !== env.pigDir || mode === 'read-only' || !reopenedPaths(env, workspace).includes(workspace.cwd)),
      // Implicit srt writes cannot be removed from allowWrite. Deny any that contain Pig, even if
      // that makes an unusually located task unwritable; never trade data protection for convenience.
      ...(env.implicitWrite ?? []).filter((path) => within(path, env.pigDir)),
      join(env.home, '.pi'), ...(env.agentDir ? [env.agentDir] : []),
      ...STARTUP_FILES.map((file) => join(env.home, file)),
      // srt's automatic denies are relative to the host cwd, not each session. Protect the actual
      // shared Git directory explicitly, while leaving index/objects/refs writable for ordinary Git.
      ...[workspace.gitCommonDir, workspace.gitDir].flatMap((gitDir) => gitDir
        ? ['hooks', 'config', 'config.worktree'].map((name) => join(gitDir, name)) : []),
      ...(workspace.gitCommonDir && workspace.gitCommonDir !== join(workspace.cwd, '.git') ? [join(workspace.cwd, '.git')] : []),
      ...(workspace.gitMetadata ? [workspace.gitMetadata] : []),
      ...(mode === 'read-only' ? [workspace.cwd, ...(workspace.gitCommonDir ? [workspace.gitCommonDir] : []),
        join(env.home, '.npm', '_logs'), join(env.home, '.claude', 'debug')] : [])
    ]
  }
}

export type PathAccess = 'read' | 'write'
export type PathVerdict = 'allow' | 'ask' | 'deny'

/**
 * Chooses which file operations need user approval before they enter the sandbox. `target` is the
 * real path (or the real path of the nearest existing parent joined with the rest). Secrets and
 * startup files are always confirmed in default mode; writes are free only inside the workspace.
 */
export function fileVerdict(mode: PermissionMode, access: PathAccess, target: string, workspace: Workspace, env: PolicyEnvironment, recursive = false): PathVerdict {
  if (mode === 'full-access') return 'allow'
  const reopened = reopenedPaths(env, workspace).some((path) => within(path, target))
  // grep/find may descend into a protected child even when the root itself is harmless. An approval
  // of that ancestor explicitly covers that whole search. ls reads only the supplied directory.
  const secret = (secretPaths(env).some((path) => within(path, target)) && !reopened) ||
    (recursive && secretPaths(env).some((path) => within(target, path)))
  const sensitiveWrite = access === 'write' && (
    secret || STARTUP_FILES.includes(basename(target)) || target.split(sep).includes('.git') || within(join(env.home, '.pi'), target) ||
    (env.agentDir !== undefined && within(env.agentDir, target)) ||
    (workspace.gitCommonDir !== null && within(workspace.gitCommonDir, target))
  )
  if (mode === 'read-only') return access === 'write' || secret ? 'deny' : 'allow'
  if (secret || sensitiveWrite) return 'ask'
  if (access === 'read') return 'allow'
  return within(workspace.cwd, target) ? 'allow' : 'ask'
}
