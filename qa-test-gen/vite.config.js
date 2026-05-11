import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// '/' for dev (no prefix). '/aaqua/' for QA (set via VITE_BASE_PATH build-arg).
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/llm-api': {
        target: 'https://llm.lab.aaseya.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm-api/, ''),
        secure: false,
      },
    },
  },
})
