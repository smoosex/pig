import { execGit } from './exec'

const MAX_BUFFER = 32 * 1024 * 1024

/**
 * Read-only git for the change review.
 *
 * `GIT_OPTIONAL_LOCKS=0` is load-bearing: `git status` otherwise refreshes and rewrites the index,
 * and the review panel watches the worktree, so that write would retrigger the scan that caused it.
 */
export function runGit(cwd: string, args: string[], options: { locale?: 'C' } = {}): Promise<string> {
  return execGit(cwd, args, {
    optionalLocks: false,
    quotePath: false,
    literalPathspecs: true,
    maxBuffer: MAX_BUFFER,
    locale: options.locale
  })
}
