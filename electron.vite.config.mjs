import { resolve } from 'path'
import { defineConfig, loadEnv, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig((command, mode) => {
  const cwd = process.cwd()
  const env = { ...loadEnv(mode, cwd, 'VITE_') }
  return {
    main: {
      plugins: [externalizeDepsPlugin()]
    },
    preload: {
      plugins: [externalizeDepsPlugin()]
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
              livekit: ['livekit-client', '@livekit/components-react'],
              documents: ['react-pdf', 'pdfjs-dist'],
              workspace: ['framer-motion']
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
          'Content-Security-Policy': "img-src * 'self' blob: data: http: https:;"
        }
      },
      publicDir: 'src/renderer'
    }
  }
})
