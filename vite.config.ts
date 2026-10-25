import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import pkg from './package.json'
import { vadStaticCopyTargets } from './build/vadAssets'

export default defineConfig(({ mode, command }) => {
  // 清理旧的 electron 产物。删不掉（文件被占用 / 系统回收站不可用）不应该让整个构建失败，
  // Rollup 会直接覆盖同名文件。
  try {
    fs.rmSync('dist-electron', { recursive: true, force: true })
  } catch (error) {
    console.warn(
      '[vite.config] 清理 dist-electron 失败，继续构建（可能有旧文件残留）:',
      error instanceof Error ? error.message : error
    )
  }

  const isServe = command === 'serve'
  const isBuild = command === 'build'
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG
  const env = loadEnv(mode, process.cwd(), '')
  const QB_BASE_URL = env.VITE_QB_URL

  return {
    resolve: {
      // vad-web imports this subpath with CommonJS `require()`. Resolve it to
      // ORT's ESM build so Vite does not embed the CommonJS wrapper (which
      // otherwise turns ORT's dynamic WASM import into a broken .vite URL).
      alias: {
        'onnxruntime-web/wasm': path.resolve(
          process.cwd(),
          'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'
        ),
      },
    },
    // The VAD package is CommonJS and imports the WASM entrypoint through a
    // require() call. Force both packages through Vite's ESM pre-bundler so
    // the renderer never evaluates that CommonJS require at runtime.
    optimizeDeps: {
      include: ['@ricky0123/vad-web', 'onnxruntime-web/wasm'],
    },
    plugins: [
      vue(),
      tailwindcss(),
      viteStaticCopy({
        targets: [...vadStaticCopyTargets],
      }),
      electron({
        main: {
          entry: 'electron/main/index.ts',
          onstart({ startup }) {
            if (process.env.VSCODE_DEBUG) {
              console.log('[startup] Electron App')
            } else {
              console.log('[Vite] Starting Electron main process...')
              // Add a small delay to prevent race conditions
              setTimeout(() => {
                startup()
              }, 100)
            }
          },
          vite: {
            build: {
              sourcemap,
              minify: isBuild,
              outDir: 'dist-electron/main',
              rollupOptions: {
                external: Object.keys(
                  'dependencies' in pkg ? pkg.dependencies : {}
                ),
                input: {
                  index: 'electron/main/index.ts',
                  'workers/pdfParserWorker':
                    'electron/main/workers/pdfParserWorker.ts',
                  'workers/teachingPdfWorker':
                    'electron/main/workers/teachingPdfWorker.ts',
                },
              },
            },
          },
        },
        preload: {
          input: 'electron/preload/index.ts',
          vite: {
            build: {
              sourcemap: sourcemap ? 'inline' : undefined,
              minify: isBuild,
              outDir: 'dist-electron/preload',
              rollupOptions: {
                external: Object.keys(
                  'dependencies' in pkg ? pkg.dependencies : {}
                ),
              },
            },
          },
        },
        renderer: {},
      }),
    ],
    css: {
      postcss: {
        plugins: [],
      },
    },
    server: (() => {
      if (process.env.VSCODE_DEBUG) {
        const url = new URL(pkg.debug.env.VITE_DEV_SERVER_URL)
        return {
          watch: {
            ignored: ['**/user-customization/**'],
          },
          host: url.hostname,
          port: +url.port,
          proxy: {
            '/api/v2': {
              target: QB_BASE_URL,
              changeOrigin: true,
              secure: false,
            },
          },
        }
      } else {
        return {
          watch: {
            ignored: ['**/user-customization/**'],
          },
          proxy: {
            '/api/v2': {
              target: QB_BASE_URL,
              changeOrigin: true,
              secure: false,
            },
          },
        }
      }
    })(),
    clearScreen: false,
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            vue: ['vue'],
            openai: ['openai'],
            vendor: ['pinia'],
          },
        },
      },
    },
    define: {
      global: {},
      __APP_MODE__: JSON.stringify(process.env.ELECTRON ? 'electron' : 'web'),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    },
  }
})
