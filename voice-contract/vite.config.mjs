import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1421,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  build: {
    outDir: '../.tmp/voice-browser-poc',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./browser-poc.html', import.meta.url)),
    },
  },
})
