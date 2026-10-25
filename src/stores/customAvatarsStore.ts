import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  CustomAvatar,
  CustomAvatarsSnapshot,
} from '../../types/customAvatars'
import videoSpeaking from '../assets/videos/speaking.mp4'
import videoStandby from '../assets/videos/standby.mp4'
import videoThinking from '../assets/videos/thinking.mp4'
import { useSettingsStore } from './settingsStore'
import { getPersona } from '../prompts/personas'

/**
 * 人格专属头像：把文件丢进 assets/videos 就会被打进包。
 * 目前一个 MP4 同时充当 standby / speaking / thinking，够用且省事；
 * 想分状态再按 <id>-speaking.mp4 这类命名扩展即可。
 */
const personaVideoModules = import.meta.glob('../assets/videos/*.mp4', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function personaAvatarVideo(personaId: string, file?: string): string | null {
  if (!file) return null
  return personaVideoModules[`../assets/videos/${personaId}.mp4`] || null
}

interface OperationResult<T> {
  success: boolean
  data?: T
  error?: string
}

const builtInAvatar: CustomAvatar = {
  id: 'alice',
  name: 'Alice',
  folderName: 'Alice',
  source: 'builtin',
  stateVideos: {
    speaking: videoSpeaking,
    standby: videoStandby,
    thinking: videoThinking,
  },
  previewVideo: videoStandby,
}

export const useCustomAvatarsStore = defineStore('customAvatars', () => {
  const customAvatars = ref<CustomAvatar[]>([])
  const customizationRoot = ref('user-customization/custom-avatars')
  const isLoading = ref(false)
  const isRefreshing = ref(false)
  const error = ref<string | null>(null)
  const initialized = ref(false)
  const lastUpdated = ref<number | null>(null)

  function mergeSnapshot(snapshot: CustomAvatarsSnapshot) {
    customAvatars.value = snapshot.avatars
    customizationRoot.value = snapshot.customizationRoot
    lastUpdated.value = Date.now()
  }

  async function fetchSnapshot() {
    if (!window.customAvatarsAPI) {
      initialized.value = true
      error.value = null
      customAvatars.value = []
      return
    }

    isLoading.value = true
    error.value = null
    try {
      const response =
        (await window.customAvatarsAPI.list()) as OperationResult<CustomAvatarsSnapshot>
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Unable to load custom avatars.')
      }
      mergeSnapshot(response.data)
    } catch (err: any) {
      error.value = err?.message || 'Unable to load custom avatars.'
    } finally {
      isLoading.value = false
      initialized.value = true
    }
  }

  async function ensureInitialized() {
    if (!initialized.value) {
      await fetchSnapshot()
    }
  }

  async function refresh() {
    if (!window.customAvatarsAPI) return
    if (isRefreshing.value) return
    isRefreshing.value = true
    error.value = null
    try {
      const response =
        (await window.customAvatarsAPI.refresh()) as OperationResult<CustomAvatarsSnapshot>
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Unable to refresh custom avatars.')
      }
      mergeSnapshot(response.data)
    } catch (err: any) {
      error.value = err?.message || 'Unable to refresh custom avatars.'
      throw err
    } finally {
      isRefreshing.value = false
    }
  }

  const allAvatars = computed<CustomAvatar[]>(() => [
    builtInAvatar,
    ...customAvatars.value,
  ])

  const settingsStore = useSettingsStore()

  const activeAvatarId = computed(
    () => settingsStore.settings.assistantAvatar || builtInAvatar.id
  )

  const activeAvatar = computed<CustomAvatar>(() => {
    // 切到男性人格后，头像也要跟着换：否则声音、自称、背景都变了，
    // 屏幕上还是原来那个女性形象，最出戏。
    const persona = getPersona(settingsStore.settings.assistantPersonaId)
    if (persona.id !== 'alice') {
      const video = personaAvatarVideo(persona.id, persona.avatarFile)
      if (video) {
        return {
          id: `persona-${persona.id}`,
          name: persona.displayName,
          folderName: persona.displayName,
          source: 'builtin',
          stateVideos: { speaking: video, standby: video, thinking: video },
          previewVideo: video,
        }
      }
      // 这个人格没有配套视频时，宁可回到 Alice 的内置三件套。
      // 沿用"当前选中的自定义头像"会张冠李戴：声音、背景都换了，脸还是别人的。
      return builtInAvatar
    }

    return (
      allAvatars.value.find(avatar => avatar.id === activeAvatarId.value) ||
      builtInAvatar
    )
  })

  const customAvatarCount = computed(() => customAvatars.value.length)

  return {
    customAvatars,
    customizationRoot,
    isLoading,
    isRefreshing,
    error,
    initialized,
    lastUpdated,
    allAvatars,
    activeAvatar,
    activeAvatarId,
    customAvatarCount,
    ensureInitialized,
    fetchSnapshot,
    refresh,
    builtInAvatar,
  }
})
