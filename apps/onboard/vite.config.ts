import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The SPA lives in web/; production build → web/dist (served by the Fastify
// server at the same origin). In dev, proxy /api to the local installer server.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4319',
      '/healthz': 'http://127.0.0.1:4319',
    },
  },
})
