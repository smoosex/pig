// Sync Pig's dynamic macOS icon catalog into the dev Electron.app bundle and sign it so Dock and notifications match packaged builds.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

function sameBytes(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false
  return readFileSync(a).equals(readFileSync(b))
}

function plistString(plist: string, key: string): string | undefined {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
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

  if (plistString(infoPlist, 'CFBundleIconName') !== 'Icon') {
    execFileSync('plutil', ['-replace', 'CFBundleIconName', '-string', 'Icon', infoPlist], { stdio: 'inherit' })
    bundleChanged = true
  }

  // usernoted caches notification icons per bundle ID + CFBundleVersion; encode an icon digest into
  // the fourth numeric version slot so icon updates invalidate stale dev notification caches.
  const iconHash = createHash('sha256')
  if (existsSync(srcCar)) iconHash.update(readFileSync(srcCar))
  if (existsSync(srcIcns)) iconHash.update(readFileSync(srcIcns))
  const iconBuild = (iconHash.digest().readUInt16BE(0) % 9000) + 1000
  const shortVersion = plistString(infoPlist, 'CFBundleShortVersionString') ?? '0.0.0'
  const expectedBundleVersion = `${shortVersion}.${iconBuild}`
  if (plistString(infoPlist, 'CFBundleVersion') !== expectedBundleVersion) {
    execFileSync('plutil', ['-replace', 'CFBundleVersion', '-string', expectedBundleVersion, infoPlist], { stdio: 'inherit' })
    bundleChanged = true
  }

  const signature = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' })
  if (signature.error) throw signature.error
  if (bundleChanged || signature.status !== 0 || signature.stderr.includes('linker-signed')) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  }

  // Electron's archive extracts Electron.app with a 1980-01-01 mtime; bump it when modified so
  // LaunchServices sees a newer bundle record.
  const latestIconMtime = Math.max(
    existsSync(srcCar) ? statSync(srcCar).mtimeMs : 0,
    existsSync(srcIcns) ? statSync(srcIcns).mtimeMs : 0,
  )
  if (bundleChanged || statSync(appPath).mtimeMs < latestIconMtime) {
    const now = new Date()
    utimesSync(appPath, now, now)
  }

  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appPath],
    { stdio: 'inherit' },
  )
}
