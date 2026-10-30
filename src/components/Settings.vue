<template>
  <div class="settings-panel text-white">
    <div
      v-if="settingsStore.isLoading && !settingsStore.initialLoadAttempted"
      class="settings-loading"
    >
      <span class="loading loading-lg loading-spinner text-primary my-4"></span>
      <p>Loading settings...</p>
    </div>

    <form
      v-else
      @submit.prevent="handleSaveAndTestSettings"
      class="settings-shell"
    >
      <!-- 左侧分类：宽屏常驻，窄屏折叠成顶部横向导航（见 settings.css） -->
      <aside class="settings-nav">
        <div class="settings-nav-brand">
          <span class="nav-title">设置</span>
          <span class="nav-sub">模型、语音、权限与外观</span>
        </div>

        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="nav-item"
          :class="{ 'nav-item-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          <span class="nav-icon">{{ tab.icon }}</span>
          <span class="nav-text">
            <span class="nav-label">{{ tab.label }}</span>
            <span class="nav-hint">{{ tab.hint }}</span>
          </span>
        </button>

        <div class="nav-footer">
          <span>Alice v{{ appVersion }}</span>
          <a
            :href="'https://github.com/pmbstyle/Alice/releases/tag/v' + appVersion"
            target="_blank"
            class="nav-link"
            >更新日志</a
          >
        </div>
      </aside>

      <main class="settings-main">
        <header class="settings-main-head">
          <div class="head-text">
            <h2 class="head-title">
              <span class="head-icon">{{ activeTabMeta.icon }}</span>
              {{ activeTabMeta.label }}
            </h2>
            <p class="head-hint">{{ activeTabMeta.hint }}</p>
          </div>
          <div class="head-actions">
            <span v-if="settingsStore.isSaving" class="saving-hint">保存中…</span>
            <button
              type="submit"
              :disabled="settingsStore.isSaving"
              class="btn-save"
            >
              {{ settingsStore.isSaving ? 'Saving...' : '保存并应用' }}
            </button>
          </div>
        </header>

        <div class="settings-scroll">
          <div
            v-if="activeTab === 'core'"
          >
            <CoreSettingsTab
              :current-settings="currentSettings"
              @update:setting="updateCurrentSetting"
            />
          </div>

          <div
            v-if="activeTab === 'assistant'"
          >
            <AssistantSettingsTab
              :current-settings="currentSettings"
              :available-models="availableModelsForSelect"
              :available-tools="availableToolsForSelect"
              :is-refreshing-models="isRefreshingModels"
              :is-tool-configured="isToolConfigured"
              @refresh-models="refreshModels"
              @reset-system-prompt="resetSystemPrompt"
            />
          </div>

          <div
            v-if="activeTab === 'hotkeys'"
          >
            <HotkeysTab
              :current-settings="currentSettings"
              :is-recording-hotkey-for="isRecordingHotkeyFor"
              @start-recording-hotkey="startRecordingHotkey"
              @clear-hotkey="clearHotkey"
            />
          </div>

          <div
            v-if="activeTab === 'integrations'"
          >
            <IntegrationsTab
              :current-settings="currentSettings"
              :google-auth-status="googleAuthStatus"
              @connect-google-services="connectGoogleServices"
              @disconnect-google-services="disconnectGoogleServices"
            />
          </div>

          <div
            v-if="activeTab === 'security'"
          >
            <SecurityTab
              :approved-commands="settingsStore.settings.approvedCommands"
              :session-approved-commands="settingsStore.sessionApprovedCommands"
              @remove-command="removeCommand"
            />
          </div>

          <div
            v-if="activeTab === 'customization'"
          >
            <UserCustomizationTab
              :current-settings="currentSettings"
              @update:setting="updateCurrentSetting"
            />
          </div>

          <div v-if="activeTab === 'memories'" class="settings-memories">
            <MemoryManager />
          </div>

          <div
            role="alert"
            class="alert alert-error mt-4"
            v-if="settingsStore.error"
          >
            <span>{{ settingsStore.error }}</span>
          </div>
          <div
            role="alert"
            class="alert alert-success mt-4"
            v-if="settingsStore.successMessage && !settingsStore.error"
          >
            <span>{{ settingsStore.successMessage }}</span>
          </div>

          <p class="settings-note">
            留空的密钥表示"保持原配置不变"。设置只在点击「保存并应用」后写入本地。
          </p>
        </div>
      </main>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useSettingsStore, type AliceSettings } from '../stores/settingsStore'
import { useConversationStore } from '../stores/conversationStore'
import { useHotkeyRecording } from '../composables/useHotkeyRecording'
import { useGoogleAuth } from '../composables/useGoogleAuth'
import {
  getStaticModelsForProvider,
  type ProviderModelDefinition,
} from '../services/llmProviders/providerCatalog'
import { PREDEFINED_OPENAI_TOOLS } from '../utils/assistantTools'
import CoreSettingsTab from './settings/CoreSettingsTab.vue'
import AssistantSettingsTab from './settings/AssistantSettingsTab.vue'
import HotkeysTab from './settings/HotkeysTab.vue'
import IntegrationsTab from './settings/IntegrationsTab.vue'
import SecurityTab from './settings/SecurityTab.vue'
import UserCustomizationTab from './settings/UserCustomizationTab.vue'
import MemoryManager from './MemoryManager.vue'

type SettingsTabId =
  | 'core'
  | 'assistant'
  | 'hotkeys'
  | 'integrations'
  | 'security'
  | 'memories'
  | 'customization'

const tabs: Array<{
  id: SettingsTabId
  icon: string
  label: string
  hint: string
}> = [
  {
    id: 'core',
    icon: '🔑',
    label: '核心 API',
    hint: '模型提供商、语音识别/合成与向量嵌入',
  },
  {
    id: 'assistant',
    icon: '🤖',
    label: 'AI 助手',
    hint: '模型参数、工具能力与补充设定',
  },
  {
    id: 'hotkeys',
    icon: '⌨️',
    label: '快捷键',
    hint: '全局按键绑定',
  },
  {
    id: 'integrations',
    icon: '🔌',
    label: '应用集成',
    hint: 'Google 日历 / 邮件与下载工具',
  },
  {
    id: 'security',
    icon: '🔒',
    label: '权限',
    hint: '命令审批与白名单',
  },
  {
    id: 'memories',
    icon: '🧠',
    label: '记忆',
    hint: '长期记忆的查看与清理',
  },
  {
    id: 'customization',
    icon: '✨',
    label: '个性化',
    hint: '形象、头像与外观',
  },
]

const appVersion = ref(import.meta.env.VITE_APP_VERSION || '')
const settingsStore = useSettingsStore()
const conversationStore = useConversationStore()
const { settings } = storeToRefs(settingsStore)

const currentSettings = ref<AliceSettings>({
  ...settings.value,
})
const activeTab = ref<SettingsTabId>('core')

const activeTabMeta = computed(
  () => tabs.find(tab => tab.id === activeTab.value) ?? tabs[0]
)

const isRefreshingModels = ref(false)

const { availableModels } = storeToRefs(conversationStore)

const {
  isRecordingHotkeyFor,
  startRecordingHotkey: startRecordingHotkeyComposable,
  clearHotkey: clearHotkeyComposable,
} = useHotkeyRecording()

const { googleAuthStatus, connectGoogleServices, disconnectGoogleServices } =
  useGoogleAuth()

const availableToolsForSelect = computed(() => {
  return PREDEFINED_OPENAI_TOOLS.map(tool => {
    const functionDef = (tool as any).function || tool
    const toolInfo = getToolInfo(functionDef.name)
    return {
      name: functionDef.name,
      description: toolInfo.description,
      displayName: toolInfo.displayName,
    }
  }).filter(tool => tool.name)
})

const availableModelsForSelect = computed(() => {
  const staticModels = getStaticModelsForProvider(
    currentSettings.value.aiProvider
  )
  if (staticModels.length > 0) {
    const staticModelIds = new Set(staticModels.map(model => model.id))
    return [
      ...staticModels.map((model: ProviderModelDefinition) => ({
        id: model.id,
      })),
      ...availableModels.value.filter(model => !staticModelIds.has(model.id)),
    ]
  }
  return availableModels.value
})

const toolDependencies: Record<string, string[]> = {
  search_torrents: ['VITE_JACKETT_API_KEY', 'VITE_JACKETT_URL'],
  add_torrent_to_qb: ['VITE_QB_URL', 'VITE_QB_USERNAME', 'VITE_QB_PASSWORD'],
  perform_web_search: ['VITE_TAVILY_API_KEY'],
  get_calendar_events: ['GOOGLE_AUTH'],
  create_calendar_event: ['GOOGLE_AUTH'],
  update_calendar_event: ['GOOGLE_AUTH'],
  delete_calendar_event: ['GOOGLE_AUTH'],
  get_unread_emails: ['GOOGLE_AUTH'],
  search_emails: ['GOOGLE_AUTH'],
  get_email_content: ['GOOGLE_AUTH'],
}
const refreshModels = async () => {
  if (isRefreshingModels.value) return

  isRefreshingModels.value = true
  try {
    await conversationStore.fetchModels()
  } catch (error) {
    console.error('Failed to refresh models:', error)
  } finally {
    isRefreshingModels.value = false
  }
}

function getToolInfo(name: string): {
  displayName: string
  description: string
} {
  const nameMap: Record<string, string> = {
    get_current_datetime: 'Current Date & Time',
    open_path: 'Open Apps/URLs',
    manage_clipboard: 'Clipboard Read/Write',
    save_memory: 'Save Memory',
    delete_memory: 'Delete Memory',
    recall_memories: 'Recall Memories',
    get_calendar_events: 'Get Calendar Events',
    create_calendar_event: 'Create Calendar Event',
    update_calendar_event: 'Update Calendar Event',
    delete_calendar_event: 'Delete Calendar Event',
    get_unread_emails: 'Get Unread Emails',
    search_emails: 'Search Emails',
    get_email_content: 'Get Email Content',
    search_torrents: 'Torrent Search',
    add_torrent_to_qb: 'Add Torrent to QB',
    perform_web_search: 'Web Search (Tavily)',
    searxng_web_search: 'Web Search (SearXNG)',
    take_screenshot: 'Screen Screenshot',
    browser_context: 'Browser Context (Extension)',
  }

  const descriptionMap: Record<string, string> = {
    get_current_datetime: 'Allows Alice to get the current date and time',
    open_path:
      "Allows Alice to open apps, URLs, files, and folders on the user's computer",
    manage_clipboard: "Alice can read and write to the user's clipboard",
    save_memory: 'Alice can store memories (long term memory)',
    delete_memory: 'Alice can delete memories (long term memory)',
    recall_memories: 'Alice can recall memories (long term memory)',
    list_directory:
      "Alice can list the files and folders on the user's computer",
    execute_command: "Alice can execute shell commands on the user's computer",
    schedule_task: 'Alice can schedule tasks to run on a recurring basis',
    manage_scheduled_tasks: 'Alice can manage scheduled tasks',
    get_calendar_events: 'Google Calendar integration to get calendar events',
    create_calendar_event:
      'Google Calendar integration to create calendar events',
    update_calendar_event:
      'Google Calendar integration to update calendar events',
    delete_calendar_event:
      'Google Calendar integration to delete calendar events',
    get_unread_emails: 'Google Gmail integration to get unread emails',
    search_emails: 'Google Gmail integration to search emails',
    get_email_content: 'Google Gmail integration to get email content',
    search_torrents:
      'Alice can search for torrents on the internet (requires Jackett)',
    add_torrent_to_qb:
      'Alice can add a torrent to qBittorrent (requires qBittorrent)',
    browser_context:
      'Alice can get information about the current webpage in users browser (requires browser extension)',
    take_screenshot:
      'Alice can capture your screen and actually look at it (errors, windows, text)',
    perform_web_search: 'For models that lack web search capabilities (Tavily)',
    searxng_web_search:
      'For models that lack web search capabilities (SearXNG)',
  }

  return {
    displayName:
      nameMap[name] ||
      name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    description: descriptionMap[name] || 'No description available',
  }
}

const resetSystemPrompt = () => {
  // 身份底稿在人格档案里，不在这里；这个框只放用户自己的补充设定
  currentSettings.value.assistantSystemPrompt = ''
}

const startRecordingHotkey = (settingKey: keyof AliceSettings) => {
  startRecordingHotkeyComposable(settingKey, currentSettings.value)
}

const clearHotkey = (settingKey: keyof AliceSettings) => {
  clearHotkeyComposable(settingKey, currentSettings.value)
}

const updateCurrentSetting = (
  key: keyof AliceSettings,
  value: string | boolean | number | string[]
) => {
  ;(currentSettings.value as any)[key] = value
}

function isToolConfigured(toolName: string): boolean {
  const currentLocalSettings = currentSettings.value
  const deps = toolDependencies[toolName]
  if (!deps) return true

  return deps.every(depKey => {
    if (depKey === 'GOOGLE_AUTH') {
      return googleAuthStatus.isAuthenticated
    }
    const value = currentLocalSettings[depKey as keyof AliceSettings]
    if (typeof value === 'string') {
      return !!value.trim()
    }
    return !!value
  })
}

onMounted(async () => {
  if (!settingsStore.initialLoadAttempted) {
    await settingsStore.loadSettings()
  }
  currentSettings.value = { ...settings.value }

  if (
    settingsStore.coreOpenAISettingsValid &&
    conversationStore.availableModels.length === 0
  ) {
    await conversationStore.fetchModels()
  }
})

watch(
  settings,
  newSettings => {
    // 只有内容真的变了才替换对象。
    // 之前每次按键都会把 currentSettings 换成新对象，输入框光标会跳到末尾，
    // 连续输入时表现为"打字打一半被吞掉"。
    if (JSON.stringify(newSettings) !== JSON.stringify(currentSettings.value)) {
      currentSettings.value = { ...newSettings }
    }
  },
  { deep: true, immediate: true }
)

watch(
  currentSettings,
  newValues => {
    for (const key in newValues) {
      if (
        settingsStore.settings[key as keyof AliceSettings] !==
        newValues[key as keyof AliceSettings]
      ) {
        const value = newValues[key as keyof AliceSettings]
        if (value !== undefined) {
          settingsStore.updateSetting(key as keyof AliceSettings, value)
        }
      }
    }
  },
  { deep: true }
)

const handleSaveAndTestSettings = async () => {
  // 不再做任何"缺项 / 配置不全就不许保存"的拦截：
  // 用户只想改一部分设置时，剩下的保持原样即可，缺什么等用到时再报。
  await settingsStore.saveAndTestSettings()

  if (window.aliceIPC && window.location.hash === '#settings') {
    try {
      const success = !settingsStore.error && settingsStore.successMessage

      await window.aliceIPC.invoke('settings:notify-main-window', {
        type: 'settings-saved',
        success: success,
        validationComplete: true,
        settingsChanged: true,
      })
    } catch (error) {
      console.error('Failed to notify main window of settings changes:', error)
    }
  }
}

const removeCommand = async (command: string) => {
  await settingsStore.removeApprovedCommand(command)
}
</script>
