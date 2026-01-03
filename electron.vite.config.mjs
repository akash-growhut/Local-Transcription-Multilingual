import { resolve } from 'path'
import { defineConfig, loadEnv, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig((command, mode) => {
  const cwd = process.cwd()
  const env = { ...loadEnv(mode, cwd, 'VITE_') }
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: resolve(__dirname, 'src/main.js')
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: resolve(__dirname, 'src/preload.js')
        }
      }
    },
    renderer: {
      build: {
        treeshake: true,
        minify: 'terser',
        rollupOptions: {
          input: {
            main: resolve(__dirname, 'src/renderer/index.html')
          },
          output: {
            manualChunks: {
              livekit: ['livekit-client']
            }
          }
        },
        terserOptions: {
          mangle: true
        },
        sourcemap: false,
        chunkSizeWarningLimit: 1000
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react()],
      assetsInclude: ['**/*.kef', '**/*.txt'],
      server: {
        port: env.VITE_PORT || 3000,
        headers: {
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src * 'self' blob: data: http: https:; font-src 'self' data:; connect-src 'self' https: wss: ws: http://localhost:*;"
        },
        fs: {
          strict: false
        }
      },
      publicDir: 'src/renderer',
      optimizeDeps: {
        include: ['react', 'react-dom']
      }
    }
  }
})
