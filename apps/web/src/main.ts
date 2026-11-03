import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

import App from './App.vue'
import router from './router'
import { useThemeStore } from './stores/theme'
import './styles/main.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(ElementPlus, { locale: zhCn })

// 主题必须在挂载前应用，否则首屏会闪一下浅色
const theme = useThemeStore(pinia)
theme.listenSystem()
theme.apply()

// 兜底：渲染期与未捕获的 Promise 异常都给出可见提示，避免页面静默失败
app.config.errorHandler = (error, _instance, info) => {
  console.error('[vue] 渲染异常', error, info)
}

window.addEventListener('unhandledrejection', (event) => {
  console.error('[promise] 未处理的异常', event.reason)
})

app.mount('#app')
