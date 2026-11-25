// Sync Pig's dynamic macOS icon catalog into the dev Electron.app bundle and sign it so Dock and notifications match packaged builds.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function sameBytes(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false
  return readFileSync(a).equals(readFileSync(b))
}

if (process.platform === 'darwin') {
  const root = join(import.meta.dirname, '..')
  const appPath = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
  if (!existsSync(appPath)) throw new Error('Electron.app not found; run bun install first')

  const resourcesDir = join(appPath, 'Contents', 'Resources')
  const infoPlist = join(appPath, 'Contents', 'Info.plist')
  const srcCar = join(root, 'build', 'Assets.car')
  const dstCar = join(resourcesDir, 'Assets.car')
  const srcIcns = join(root, 'build', 'icon.icns')
  const dstIcns = join(resourcesDir, 'electron.icns')

  let bundleChanged = false
  if (existsSync(srcCar) && !sameBytes(srcCar, dstCar)) {
    copyFileSync(srcCar, dstCar)
    bundleChanged = true
  }
  if (existsSync(srcIcns) && !sameBytes(srcIcns, dstIcns)) {
    copyFileSync(srcIcns, dstIcns)
    bundleChanged = true
  }

  const iconName = spawnSync('plutil', ['-extract', 'CFBundleIconName', 'raw', '-o', '-', infoPlist], { encoding: 'utf8' })
  if (iconName.status !== 0 || iconName.stdout.trim() !== 'Icon') {
    execFileSync('plutil', ['-replace', 'CFBundleIconName', '-string', 'Icon', infoPlist], { stdio: 'inherit' })
    bundleChanged = true
  }

  const signature = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' })
  if (signature.error) throw signature.error
  if (bundleChanged || signature.status !== 0 || signature.stderr.includes('linker-signed')) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  }

  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appPath],
    { stdio: 'inherit' },
  )
}
