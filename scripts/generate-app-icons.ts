/** Build committed application icons (including macOS dynamic Light/Dark Assets.car); packaging itself needs no image tools. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') {
  throw new Error('Generating the complete icon set requires macOS xcrun actool, iconutil, rsvg-convert and ImageMagick')
}

const root = resolve(import.meta.dirname, '..')
const build = join(root, 'build')
const work = mkdtempSync(join(tmpdir(), 'pig-app-icons-'))
const iconset = join(work, 'Pig.iconset')
const actoolOut = join(work, 'actool')
mkdirSync(build, { recursive: true })
mkdirSync(iconset)
mkdirSync(actoolOut)

try {
  // 1. Compile resources/Icon.icon into macOS Asset Catalog (build/Assets.car) with Light + Dark appearances
  const iconComposerCopy = join(work, 'Icon.icon')
  execFileSync('cp', ['-R', join(root, 'resources/Icon.icon'), iconComposerCopy], { stdio: 'inherit' })
  execFileSync(
    'xcrun',
    [
      'actool',
      iconComposerCopy,
      '--compile',
      actoolOut,
      '--output-format',
      'human-readable-text',
      '--notices',
      '--warnings',
      '--errors',
      '--output-partial-info-plist',
      join(actoolOut, 'assetcatalog_generated_info.plist'),
      '--app-icon',
      'Icon',
      '--include-all-app-icons',
      '--enable-on-demand-resources',
      'NO',
      '--development-region',
      'en',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '13.0',
      '--platform',
      'macosx',
    ],
    { stdio: 'inherit' },
  )
  const compiledCar = join(actoolOut, 'Assets.car')
  if (statSync(compiledCar).size === 0) throw new Error('actool produced an empty Assets.car')
  copyFileSync(compiledCar, join(build, 'Assets.car'))

  // 2. Build static squircle icons for fallback macOS .icns, Linux .png and Windows .ico
  const master = join(work, 'master.png')
  execFileSync('rsvg-convert', ['--width', '1024', '--height', '1024', '--output', master, join(root, 'resources/icon.svg')], { stdio: 'inherit' })
  execFileSync('magick', [master, '-strip', join(build, 'icon.png')], { stdio: 'inherit' })
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const output = join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)
      execFileSync('magick', [master, '-resize', `${size * scale}x${size * scale}`, '-strip', output], { stdio: 'inherit' })
    }
  }
  execFileSync('iconutil', ['--convert', 'icns', '--output', join(build, 'icon.icns'), iconset], { stdio: 'inherit' })
  execFileSync('magick', [master, '-define', 'icon:auto-resize=256,128,64,48,32,16', join(build, 'icon.ico')], { stdio: 'inherit' })
  console.log('Generated build/Assets.car, build/icon.png, build/icon.icns and build/icon.ico')
} finally {
  rmSync(work, { recursive: true, force: true })
}
