import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
// import path from 'path'

export default defineConfig({
  plugins: [react(), tsconfigPaths()]
  // server: {
  //   fs: {
  //     allow: [
  //       // Allow serving files from the frontend directory
  //       path.resolve(__dirname),
  //       // Allow serving files from the surge-livekit-react directory
  //       path.resolve(__dirname, '../surge-livekit-react')
  //     ]
  //   }
  // }
})
