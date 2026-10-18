/** Build committed application icons from resources/icon.svg; packaging itself needs no image tools. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('Generating the complete icon set requires macOS iconutil, rsvg-convert and ImageMagick')

const root = resolve(import.meta.dirname, '..')
const build = join(root, 'build')
const work = mkdtempSync(join(tmpdir(), 'pig-app-icons-'))
const iconset = join(work, 'Pig.iconset')
mkdirSync(build, { recursive: true })
mkdirSync(iconset)

try {
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
  console.log('Generated build/icon.png, build/icon.icns and build/icon.ico')
} finally {
  rmSync(work, { recursive: true, force: true })
}
