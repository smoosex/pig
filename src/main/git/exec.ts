import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { t } from '../i18n'

const exec = promisify(execFile)

export interface GitExecOptions {
  optionalLocks?: boolean
  quotePath?: boolean
  literalPathspecs?: boolean
  maxBuffer?: number
  locale?: 'C'
}

export class GitExecError extends Error {
  code?: string | number | null
  stdout?: string
  stderr?: string
  killed?: boolean
  signal?: NodeJS.Signals | null

  constructor(message: string, cause: Error & {
    code?: string | number | null
    stdout?: string
    stderr?: string
    killed?: boolean
    signal?: NodeJS.Signals | null
  }) {
    super(message)
    this.name = 'GitExecError'
    this.code = cause.code
    this.stdout = cause.stdout
    this.stderr = cause.stderr
    this.killed = cause.killed
    this.signal = cause.signal
  }
}

export function isNotARepoError(error: unknown): boolean {
  return error instanceof GitExecError
    && typeof error.code === 'number'
    && error.stderr?.includes('not a git repository') === true
}

export async function execGit(cwd: string, args: string[], options: GitExecOptions = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (options.optionalLocks === false) env.GIT_OPTIONAL_LOCKS = '0'
  if (options.locale === 'C') env.LC_ALL = 'C'
  for (const key of Object.keys(env)) {
    if (!key.startsWith('GIT_')) continue
    if (key === 'GIT_TERMINAL_PROMPT') continue
    if (key === 'GIT_OPTIONAL_LOCKS' && options.optionalLocks === false) continue
    delete env[key]
  }

  const commandArgs = ['-C', cwd]
  if (options.quotePath === false) commandArgs.push('-c', 'core.quotepath=false')
  if (options.literalPathspecs) commandArgs.push('--literal-pathspecs')
  commandArgs.push(...args)

  try {
    const { stdout } = await exec('git', commandArgs, {
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024
    })
    return stdout
  } catch (error) {
    const cause = error as Error & {
      code?: string | number | null
      stdout?: string
      stderr?: string
      killed?: boolean
      signal?: NodeJS.Signals | null
    }
    const message = cause.code === 'ENOENT'
      ? t('error.gitMissing')
      : cause.stderr?.trim() || cause.message
    throw new GitExecError(message, cause)
  }
}
