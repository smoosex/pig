import { expect, test } from 'bun:test'
import { fileVerdict, sandboxFilesystem, writeRoots, type PolicyEnvironment, type Workspace } from '../src/main/sandbox/policy'

const env: PolicyEnvironment = { home: '/Users/me', pigDir: '/Users/me/.pig', temporary: ['/private/tmp'] }
const project: Workspace = { cwd: '/Users/me/code/app', gitCommonDir: '/Users/me/code/app/.git' }
const worktree: Workspace = { cwd: '/Users/me/.pig/worktrees/app/one', gitCommonDir: '/Users/me/code/app/.git' }

test('file tools write freely only inside the workspace and always ask for secrets and startup files', () => {
  const verdict = (path: string, access: 'read' | 'write' = 'write', workspace = project) => fileVerdict('default', access, path, workspace, env)
  expect(verdict('/Users/me/code/app/src/a.ts')).toBe('allow')
  expect(verdict('/Users/me/code/other/a.ts')).toBe('ask')
  expect(verdict('/Users/me/code/other/a.ts', 'read')).toBe('allow')
  expect(verdict('/Users/me/.ssh/id_ed25519', 'read')).toBe('ask')
  expect(verdict('/Users/me/.ssh/known_hosts', 'read')).toBe('allow')
  expect(verdict('/Users/me/.pig/mcp.json', 'read')).toBe('ask')
  expect(verdict('/Users/me/.pi/agent/auth.json', 'read')).toBe('ask')
  expect(verdict('/Users/me/.zshrc')).toBe('ask')
  expect(verdict('/Users/me/code/app/.git/hooks/pre-commit')).toBe('ask')
  expect(verdict('/Users/me/.pi/agent/settings.json')).toBe('ask')
  // A worktree lives in Pig's data directory, which stays protected around it.
  expect(verdict('/Users/me/.pig/worktrees/app/one/src/a.ts', 'write', worktree)).toBe('allow')
  expect(verdict('/Users/me/.pig/permissions.json', 'write', worktree)).toBe('ask')
})

test('a workspace containing the data directory does not reopen it', () => {
  // Pig's own repository in development keeps its data in `<repo>/.pig`.
  const dev: PolicyEnvironment = { ...env, pigDir: '/Users/me/code/pig/.pig' }
  const repo: Workspace = { cwd: '/Users/me/code/pig', gitCommonDir: '/Users/me/code/pig/.git' }
  expect(fileVerdict('default', 'read', '/Users/me/code/pig/.pig/permissions.json', repo, dev)).toBe('ask')
  expect(sandboxFilesystem('default', repo, dev).allowRead).not.toContain('/Users/me/code/pig')
  expect(sandboxFilesystem('default', worktree, env).allowRead).toContain(worktree.cwd)
})

test('canonical protected roots and recursive ancestor searches stay protected', () => {
  const aliases = { ...env, canonical: { '/Users/me/.ssh': '/vault/ssh' } }
  expect(fileVerdict('default', 'read', '/vault/ssh/key', project, aliases)).toBe('ask')
  expect(fileVerdict('read-only', 'read', '/vault/ssh/key', project, aliases)).toBe('deny')
  expect(fileVerdict('default', 'read', '/vault', project, aliases, true)).toBe('ask')
  expect(sandboxFilesystem('default', project, aliases).denyRead).toContain('/vault/ssh')
  expect(sandboxFilesystem('read-only', project, env).denyWrite).toEqual(expect.arrayContaining(['/Users/me/.npm/_logs', '/Users/me/.claude/debug']))
  expect(sandboxFilesystem('default', worktree, env).allowRead).not.toContain('/Users/me/.pig/worktrees')
})

test('read-only refuses writes and secrets, full access allows everything', () => {
  expect(fileVerdict('read-only', 'write', '/Users/me/code/app/a.ts', project, env)).toBe('deny')
  expect(fileVerdict('read-only', 'read', '/Users/me/.aws/credentials', project, env)).toBe('deny')
  expect(fileVerdict('read-only', 'read', '/Users/me/code/app/a.ts', project, env)).toBe('allow')
  expect(fileVerdict('full-access', 'write', '/Users/me/.pig/permissions.json', project, env)).toBe('allow')
})

test('sandboxed commands write the workspace, its repository and caches; read-only only temporary folders', () => {
  expect(writeRoots('default', worktree, env)).toEqual(expect.arrayContaining([worktree.cwd, '/Users/me/code/app/.git', '/private/tmp', '/Users/me/.npm']))
  expect(writeRoots('default', project, env)).not.toContain('/Users/me/code/app/.git')
  expect(writeRoots('read-only', worktree, env)).toEqual(['/private/tmp'])
  expect(sandboxFilesystem('default', project, env).denyRead).toEqual(expect.arrayContaining(['/Users/me/.ssh', '/Users/me/.pig', '/Users/me/.pi/agent/auth.json']))
})

test('an ungranted Git layout keeps its .git entry and pointed hooks read-only while the workspace stays writable', () => {
  const sub = { cwd: '/Users/me/code/app/lib', gitCommonDir: null, gitMetadata: '/Users/me/code/app/lib/.git', gitDir: '/Users/me/code/app/.git/modules/lib' }
  const filesystem = sandboxFilesystem('default', sub, env)
  expect(filesystem.allowWrite).toContain(sub.cwd)
  expect(filesystem.allowWrite).not.toContain(sub.gitDir)
  expect(filesystem.denyWrite).toEqual(expect.arrayContaining([sub.gitMetadata, `${sub.gitDir}/hooks`, `${sub.gitDir}/config`]))
})
