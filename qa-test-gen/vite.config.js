import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// '/' for dev (no prefix). '/aaqua/' for QA (set via VITE_BASE_PATH build-arg).
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: {
      ignored: [
        '**/server/**',
        '**/temp_uploads/**',
        '**/temp_screenshots/**',
        '**/scratch/**',
        '**/temp_*/**',
        '**/playwright-results/**',
        '**/test-results/**',
        '**/*.zip',
        '**/*.bak',
        '**/*.xlsx',
        '**/*.xls',
        '**/*.csv',
        '**/*.sqlite*',
        '**/*.log',
        '**/*.html',
        '**/*.png',
        '**/*.jpg',
        '**/*.jpeg',
        '**/screenshots/**',
        '**/playwright/.cache/**'
      ]
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
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
