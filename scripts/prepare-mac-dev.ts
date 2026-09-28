// Electron's linker signature cannot deliver macOS notifications; sign the dev bundle only once.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform === 'darwin') {
  const appPath = join(import.meta.dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app')
  if (!existsSync(appPath)) throw new Error('Electron.app not found; run bun install first')

  const signature = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' })
  if (signature.error) throw signature.error
  if (signature.status !== 0 || signature.stderr.includes('linker-signed')) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  }

  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appPath],
    { stdio: 'inherit' }
  )
}
