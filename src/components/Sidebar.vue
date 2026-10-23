<template>
  <div
    class="sidebar-wrapper fixed top-0 bottom-0 right-0 bg-gray-900/95 flex flex-col z-10 rounded-r-lg overflow-hidden"
    :class="{ open: openSidebar }"
    :style="{
      left: generalStore.windowMaximized
        ? '300px'
        : generalStore.windowMode === 'window'
          ? '340px'
          : '480px',
    }"
  >
    <div
      class="sidebar-content w-full flex-1 min-h-0 flex flex-col relative overflow-hidden"
    >
      <ChatCockpit
        v-if="sideBarView === 'chat'"
        :disabled="!isConversationReady"
        @send="handleSend"
      />
      <div
        v-else-if="sideBarView === 'memories'"
        class="flex flex-col h-full min-h-0"
      >
        <div
          class="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0"
        >
          <button
            class="text-xs text-gray-400 hover:text-white transition-colors"
            @click="generalStore.sideBarView = 'chat'"
          >
            ← 返回对话
          </button>
          <span class="text-xs text-gray-500 ml-auto">记忆管理</span>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto">
          <MemoryManagerComponent />
        </div>
      </div>

      <div
        v-if="
          sideBarView === 'chat' &&
          !isConversationReady &&
          !settingsStore.isLoading &&
          !generalStore.chatHistory.length
        "
        class="absolute inset-0 flex items-center justify-center text-center p-4 z-20 bg-gray-900/70"
      >
        <div class="text-white">
          <p class="text-lg font-semibold mb-2">
            {{
              generalStore.statusMessage.includes('Error:')
                ? 'Initialization Failed'
                : 'Initializing Alice'
            }}
          </p>
          <p
            v-if="generalStore.statusMessage.includes('Error:')"
            class="text-sm text-red-400"
          >
            {{ generalStore.statusMessage }}
          </p>
          <p v-else class="text-sm">Please wait...</p>

          <button
            v-if="generalStore.statusMessage.includes('Error:')"
            @click="retryInitialization"
            class="mt-4 btn btn-sm btn-warning"
          >
            Retry Init
          </button>
          <button
            v-if="generalStore.statusMessage.includes('Error:')"
            @click="openSettingsWindow"
            class="mt-4 ml-2 btn btn-sm btn-info"
          >
            Check Settings
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import ChatCockpit from './chat/ChatCockpit.vue'
import MemoryManagerComponent from './MemoryManager.vue'
import { useGeneralStore } from '../stores/generalStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useConversationStore } from '../stores/conversationStore'
import { useConversationLogStore } from '../stores/conversationLogStore'
import { storeToRefs } from 'pinia'

const generalStore = useGeneralStore()
const settingsStore = useSettingsStore()
const conversationStore = useConversationStore()

const emit = defineEmits(['processRequest'])

const { openSidebar, sideBarView } = storeToRefs(generalStore)
const { isInitialized: conversationIsInitialized } =
  storeToRefs(conversationStore)

const isConversationReady = computed(() => conversationIsInitialized.value)

const openSettingsWindow = async () => {
  if (window.aliceIPC) {
    try {
      await window.aliceIPC.invoke('settings-window:open')
    } catch (error) {
      console.error('Failed to open settings window:', error)
    }
  }
}

const handleSend = (text: string) => {
  emit('processRequest', text)
}

const retryInitialization = async () => {
  if (!conversationStore.isInitialized) {
    generalStore.statusMessage = 'Retrying init...'
    await conversationStore.initialize()
  }
}

const restoreInteractiveAudioState = () => {
  if (generalStore.isRecordingRequested) {
    generalStore.setAudioState('LISTENING')
  } else {
    generalStore.setAudioState('IDLE')
  }
}

onMounted(async () => {
  if (!settingsStore.initialLoadAttempted) {
    await settingsStore.loadSettings()
  }

  const needsSettingsConfig =
    settingsStore.isProduction && !settingsStore.areEssentialSettingsProvided
  const canInitializeAI = settingsStore.areEssentialSettingsProvided
  const aiNeedsInitialization =
    canInitializeAI && !conversationStore.isInitialized

  if (needsSettingsConfig) {
    openSettingsWindow()
    generalStore.setAudioState('CONFIG')
  } else if (aiNeedsInitialization) {
    generalStore.statusMessage = 'Initializing AI...'

    const initSuccess = await conversationStore.initialize()
    if (initSuccess) {
      if (
        generalStore.audioState === 'CONFIG' ||
        generalStore.statusMessage.startsWith('Initializing AI')
      ) {
        restoreInteractiveAudioState()
      }
    } else {
      console.log('[Sidebar] AI initialization failed on mount.')
    }
  } else if (conversationStore.isInitialized) {
    if (generalStore.audioState === 'CONFIG') {
      restoreInteractiveAudioState()
    } else if (
      generalStore.audioState !== 'LISTENING' &&
      generalStore.audioState !== 'SPEAKING' &&
      generalStore.audioState !== 'PROCESSING_AUDIO' &&
      generalStore.audioState !== 'WAITING_FOR_RESPONSE' &&
      !generalStore.isRecordingRequested
    ) {
      generalStore.setAudioState('IDLE')
    }
  } else {
    if (generalStore.audioState === 'CONFIG') generalStore.setAudioState('IDLE')
  }

  // 从"圆形头像"切到"正常窗口"会重建窗口、重载渲染进程，
  // 这里把上一次的会话捞回来，用户感觉不到中断
  await restorePendingSession()
})

async function restorePendingSession() {
  try {
    const pendingId = window.localStorage.getItem('alice:restore-session')
    if (!pendingId) return
    window.localStorage.removeItem('alice:restore-session')

    const logStore = useConversationLogStore()
    const restored = await logStore.loadSession(pendingId)
    if (restored) {
      generalStore.statusMessage = '已恢复上次对话'
    }
  } catch (error) {
    console.warn('[Sidebar] 恢复上次会话失败:', error)
  }
}

watch(
  () => settingsStore.successMessage,
  async newMessage => {
    if (newMessage) {
      if (
        conversationStore.isInitialized &&
        settingsStore.areEssentialSettingsProvided
      ) {
        settingsStore.successMessage = null

        setTimeout(() => {
          // Keep chat selected when the user opens the panel after settings close.
          generalStore.sideBarView = 'chat'
          if (window.aliceIPC) {
            window.aliceIPC.invoke('settings-window:close').catch(console.error)
          }
          if (generalStore.audioState === 'CONFIG') {
            restoreInteractiveAudioState()
          }
        }, 1500)
      } else {
        console.warn(
          '[Sidebar] Settings saved (message: "',
          newMessage,
          '"), but AI store initialization failed.'
        )
      }
    }
  }
)
</script>
