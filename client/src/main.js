import './assets/main.css'

import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'flag-icons/css/flag-icons.min.css'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import api from './services/api'

const app = createApp(App)

app.use(router)
app.use(i18n)
app.use(ElementPlus)

// Make sure the httpOnly image cookie exists before any <img src="/api/s3/..."> loads
let hasToken = false
try {
  hasToken = !!localStorage.getItem('token')
} catch (e) {}

const sessionReady = hasToken ? api.refreshSession().catch(() => {}) : Promise.resolve()
sessionReady.finally(() => app.mount('#app'))
