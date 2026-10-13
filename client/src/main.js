import { createApp } from 'vue'
// Components are imported on demand (vite.config.js); only the v-loading directive is global
import { ElLoading } from 'element-plus'
import 'element-plus/dist/index.css'
// Official dark-mode variables for every component (applied by html.dark)
import 'element-plus/theme-chalk/dark/css-vars.css'
import 'flag-icons/css/flag-icons.min.css'
// Brand theme last, so it overrides Element Plus defaults
import './assets/main.css'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import api from './services/api'
import { initPwa } from './composables/usePush'

const app = createApp(App)

app.use(router)
app.use(i18n)
app.use(ElLoading)

// Make sure the httpOnly image cookie exists before any <img src="/api/s3/..."> loads
let hasToken = false
try {
  hasToken = !!localStorage.getItem('token')
} catch (e) {}

const sessionReady = hasToken ? api.refreshSession().catch(() => {}) : Promise.resolve()
sessionReady.finally(() => app.mount('#app'))

// Installable app + push notifications
initPwa()
