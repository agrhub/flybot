import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

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
    // Element Plus components are imported where they are used (smaller first load).
    // Styles stay global (main.js) so ElMessage/ElNotification/ElMessageBox keep theirs.
    Components({
      resolvers: [ElementPlusResolver({ importStyle: false })],
      dts: false,
    }),
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
