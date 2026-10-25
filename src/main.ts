import './assets/styles.css'

import { createApp } from 'vue'
import { installLogConsoleApi } from './utils/logger'
import { createPinia } from 'pinia'
import router from './router/main.ts'
import { initializeClients } from './services/apiClients'
import { registerCodexToolBridge } from './services/llmProviders/codexToolBridge'

import App from './App.vue'

installLogConsoleApi()
const app = createApp(App)

app.use(createPinia())
app.use(router)
registerCodexToolBridge()

async function startApp(): Promise<void> {
  try {
    await router.isReady()
  } catch (error) {
    console.error('Router failed to finish initial navigation:', error)
  }

  try {
    await initializeClients()
    console.log('All clients initialized, mounting app')
  } catch (error) {
    console.error('Failed to initialize clients, mounting app anyway:', error)
  } finally {
    app.mount('#app')
  }
}

void startApp()
