<template>
  <template v-if="showOnboarding || showSettings || showOverlay">
    <Overlay v-if="showOverlay" />
    <OnboardingWizard v-if="showOnboarding" />
    <SettingsWindow v-if="showSettings" />
  </template>
  <Main v-else />
  <div
    role="alert"
    class="alert alert-vertical sm:alert-horizontal update-notification"
    v-if="updateAvailable"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      class="stroke-info h-6 w-6 shrink-0"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      ></path>
    </svg>
    <span>A new version {{ updateInfo.version }} of Alice is available!</span>
    <div class="flex items-center">
      <button class="btn btn-sm mr-2" @click="updateAvailable = false">
        Ignore
      </button>
      <button
        class="btn btn-sm btn-primary btn-active"
        @click="installUpdate()"
      >
        <template v-if="!generalStore.isMiniBall">Install & Restart</template>
        <template v-else>Install</template>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router'
import Main from './components/Main.vue'
import Overlay from './components/Overlay.vue'
import OnboardingWizard from './components/wizard/OnboardingWizard.vue'
import SettingsWindow from './components/SettingsWindow.vue'
import { useSettingsStore } from './stores/settingsStore'
import { useGeneralStore } from './stores/generalStore'
import { useConversationStore } from './stores/conversationStore'
import { useConversationLogStore } from './stores/conversationLogStore'
import { usePersonaStore } from './stores/personaStore'
import { settleMemories, snapshotConversation } from './modules/memory/autoMemory'
import { computed, onMounted, onUnmounted, ref } from 'vue'

const route = useRoute()
const settingsStore = useSettingsStore()
const generalStore = useGeneralStore()
const conversationStore = useConversationStore()

const showOverlay = computed(() => {
  return route.hash === '#overlay'
})

const showSettings = computed(() => {
  return route.hash === '#settings'
})

const showOnboarding = computed(() => {
  if (!settingsStore.initialLoadAttempted) {
    return false
  }
  return route.hash !== '#settings' && route.hash !== '#overlay' && !settingsStore.settings.onboardingCompleted
})

/**
 * 设置保存后在这里"就地生效"。
 *
 * 以前的做法是 production 下 app.relaunch、dev 下 location.reload，
 * 结果是聊天、英语模式、课堂进度全部被掀掉。绝大多数设置本来就是在每次
 * 调用时现读的，只需要把新配置读进内存；本地 Go 后端那种启动期读参的，
 * 单独重启后端进程即可，不必动界面。
 */
const applySavedSettings = async () => {
  const previous = { ...settingsStore.config }
  generalStore.statusMessage = '正在应用设置…'

  try {
    await settingsStore.reloadFromDisk()
    // 身份可能换了：把新人格已经记下的细节读回来，下一句起就用新档案
    await personaStore.load(settingsStore.config.assistantPersonaId, true)

    // 只有换供应商才值得重新拉一次模型列表（要发网络请求）
    if (settingsStore.config.aiProvider !== previous.aiProvider) {
      void conversationStore.fetchModels()
    }

    const localTouched =
      previous.sttProvider !== settingsStore.config.sttProvider ||
      previous.ttsProvider !== settingsStore.config.ttsProvider ||
      previous.embeddingProvider !== settingsStore.config.embeddingProvider ||
      previous.localSttModel !== settingsStore.config.localSttModel ||
      previous.localTtsVoice !== settingsStore.config.localTtsVoice
    const usesLocal =
      settingsStore.config.sttProvider === 'local' ||
      settingsStore.config.ttsProvider === 'local' ||
      settingsStore.config.embeddingProvider === 'local'

    if (localTouched && usesLocal) {
      try {
        await window.aliceIPC?.invoke('backend:stop')
        await window.aliceIPC?.invoke('backend:start')
      } catch (error) {
        console.warn('[App] 本地后端重启失败:', error)
      }
    }

    generalStore.statusMessage = '设置已应用'
    window.setTimeout(() => {
      if (generalStore.statusMessage === '设置已应用') {
        generalStore.statusMessage = 'Stand by'
      }
    }, 2500)
  } catch (error) {
    console.error('[App] 应用设置失败:', error)
    generalStore.statusMessage = '应用设置失败，请查看日志'
  }
}

const updateAvailable = ref(false)
const updateInfo = ref<any>()

const conversationLogStore = useConversationLogStore()
const personaStore = usePersonaStore()

/**
 * 主进程在窗口收起或程序退出前会发这个事件，等我们把聊天记录落库、
 * 把这一段的记忆整理完再放行。超时由主进程兜底，这里只做尽力而为。
 */
const flushRendererState = async (reason: string) => {
  try {
    const conversation = snapshotConversation()
    await conversationLogStore.flush(`lifecycle:${reason}`)
    if (conversation.length > 0) {
      // 不强制：收起窗口很频繁，冷却与"有没有新消息"两道闸得留着，
      // 否则每收一次窗口就白调一次模型。切会话那条路径才需要 force。
      await settleMemories(`lifecycle:${reason}`, {
        messages: conversation,
        // 退出时主进程只等 3.5 秒，模型调用必须收得更紧；
        // 收起窗口进程还活着，可以给足时间。
        timeoutMs: reason === 'quit' ? 2500 : 10_000,
      })
    }
  } catch (error) {
    console.warn('[App] flush before shutdown failed:', error)
  } finally {
    try {
      window.aliceIPC?.send('app:flush-done', { reason })
    } catch {
      // 主进程已退出时忽略
    }
  }
}

const installUpdate = () => {
  window.aliceIPC.send('restart-and-install-update')
}

const handleContextAction = async (data: any) => {
  try {
    const { prompt } = data

    await conversationStore.initialize()
    await conversationStore.chatWithContextAction(prompt)
  } catch (error) {
    // Handle context action error silently
  }
}

onMounted(async () => {
  await settingsStore.loadSettings()

  // 自动保存历史与记忆不依赖某个界面是否挂在树上：主窗口一起来就启动
  conversationLogStore.start()
  await personaStore.load(settingsStore.config.assistantPersonaId)

  if (window.aliceIPC) {
    window.aliceIPC.on('app:flush-state', (payload: any) => {
      void flushRendererState(String(payload?.reason || 'unknown'))
    })

    window.aliceIPC.on('update-downloaded', info => {
      updateInfo.value = info
      updateAvailable.value = true
    })

    window.aliceIPC.on('context-action', data => {
      handleContextAction(data)
    })

    window.aliceIPC.on('settings-changed', async data => {
      if (data.type === 'settings-saved' && data.success) {
        // 保存设置不再 reload / relaunch：那会把正在进行的聊天、英语练习、
        // 课堂全部掀掉。这里只把新配置读进内存，让后续每一次调用用新值。
        await applySavedSettings()
      } else if (data.type === 'settings-saved' && !data.success) {
        console.log('[App] Settings save reported failure, keeping old settings')
        generalStore.statusMessage = '设置没有保存成功，仍在使用旧配置'
      }
    })
  }
})

onUnmounted(() => {
  if (window.aliceIPC) {
    window.aliceIPC.removeAllListeners('update-downloaded')
    window.aliceIPC.removeAllListeners('context-action')
    window.aliceIPC.removeAllListeners('kokoro-tts-progress')
    window.aliceIPC.removeAllListeners('local-embedding-progress')
    window.aliceIPC.removeAllListeners('settings-changed')
    window.aliceIPC.removeAllListeners('app:flush-state')
  }
})
</script>

<style scoped lang="postcss">
.update-notification {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
}
</style>
