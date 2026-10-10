import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  envDir: '../',
  envPrefix: ['VITE_', 'GOOGLE_'],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        secure: false,      
        ws: true,
      },
    },
  },
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'vue': path.resolve(__dirname, '../node_modules/vue')
    },
    dedupe: ['vue', 'vue-router', 'vue-i18n', 'element-plus']
  },
  optimizeDeps: {
    include: ['vue', 'vue-router', 'vue-i18n', 'element-plus', 'axios']
  }
})
