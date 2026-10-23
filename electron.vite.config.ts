import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'branch-namer-worker': resolve(__dirname, 'src/main/pi/branch-namer-worker.ts'),
          'pty-host-worker': resolve(__dirname, 'src/main/terminal/pty-host-worker.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main')
      }
    }
  },
  preload: {
    plugins: [{
      name: 'sandboxed-preload-single-files',
      generateBundle(_options, bundle) {
        // Sandboxed preload require() cannot load local chunks shared by multiple entries.
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk' && !output.isEntry) {
            this.error(`Sandboxed preloads must be standalone: unexpected chunk ${output.fileName}`)
          }
        }
      }
    }],
    build: {
      isolatedEntries: true,
      externalizeDeps: false,
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'browser-guest': resolve(__dirname, 'src/preload/browser-guest.ts')
        },
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
