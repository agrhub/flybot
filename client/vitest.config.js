import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Unit and component tests (tests/unit). The end-to-end checks against the demo live in
// tests/e2e and run with node --test.
export default defineConfig({
  // Absolute paths in templates (/logo.png) are public files, not modules to import
  plugins: [vue({ template: { transformAssetUrls: { includeAbsolute: false } } })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.js'],
    setupFiles: ['tests/unit/setup.js'],
    // Element Plus ships ES modules with CSS imports
    server: { deps: { inline: ['element-plus'] } },
    css: false
  }
})
