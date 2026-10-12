import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// https://vite.dev/config/
// offline-files.json: the app shell and every page (with their CSS and shared code), for the
// service worker to save on install so pages open without signal. Libraries loaded on demand
// (PDF, Excel, video player) stay out: they are big and only needed online.
function offlineFileList() {
  return {
    name: 'flybot-offline-files',
    apply: 'build',
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).filter(c => c.type === 'chunk');
      const byFile = new Map(chunks.map(c => [c.fileName, c]));
      const files = new Set(['/']);
      const add = (chunk) => {
        if (!chunk || files.has('/' + chunk.fileName)) return;
        files.add('/' + chunk.fileName);
        for (const css of chunk.viteMetadata?.importedCss || []) files.add('/' + css);
        for (const imported of chunk.imports) add(byFile.get(imported));
      };
      for (const chunk of chunks) {
        if (chunk.isEntry || /[\/]src[\/](pages|layouts)[\/]/.test(chunk.facadeModuleId || '')) add(chunk);
      }
      this.emitFile({ type: 'asset', fileName: 'offline-files.json', source: JSON.stringify([...files]) });
    }
  };
}

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
    offlineFileList(),
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
