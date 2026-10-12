import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Unit and component tests (tests/unit). The end-to-end checks against the demo live in
// tests/e2e and run with node --test.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.js'],
    // Element Plus ships ES modules with CSS imports
    server: { deps: { inline: ['element-plus'] } },
    css: false
  }
})
