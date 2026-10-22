/* Bundle the vendored system plugins into single files the Pi extension loader can import. */
import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The SDK aliases @earendil-works/* and typebox through jiti, so those stay external; every
// other dependency is inlined because the packaged app ships no node_modules for plugins.
for (const name of ['pi-web-access', 'pi-persona']) {
  const source = join(root, 'src/main/plugins', name)
  const outDir = join(root, 'out/system-plugins', name)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await build({
    entryPoints: [join(source, 'index.ts')],
    outfile: join(outDir, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@earendil-works/*', 'typebox', 'typebox/*'],
    // Bundled dependencies can retain CJS requires even inside ESM output.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning'
  })
  await cp(join(source, 'LICENSE'), join(outDir, 'LICENSE'))
  console.log(`system plugin bundled: ${join(outDir, 'index.js')}`)
}
