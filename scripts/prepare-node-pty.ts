/**
 * node-pty 1.1.0 publishes its macOS spawn-helper without the execute bit, and its own install
 * scripts leave it that way. Every shell spawn then fails with `posix_spawnp failed`, in dev and in
 * the packaged app alike (electron-builder copies the mode as-is), so the bit is set at install time.
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'node_modules', 'node-pty')
const helpers = [
  join(root, 'build', 'Release', 'spawn-helper'),
  ...readdirSync(join(root, 'prebuilds'))
    .filter((dir) => dir.startsWith('darwin-'))
    .map((dir) => join(root, 'prebuilds', dir, 'spawn-helper'))
]
for (const helper of helpers) if (existsSync(helper)) chmodSync(helper, 0o755)
