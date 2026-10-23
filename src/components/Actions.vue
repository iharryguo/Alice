<template>
  <div class="absolute bottom-0 py-2 z-20 flex flex-col w-full bg-black/60">
    <div class="pb-2 rounded-lg flex items-center justify-center gap-8">
      <img
        :src="micIconSrc"
        class="indicator"
        :class="{ 'mini-ball': isMiniBall }"
        @click="!isConfigState ? emit('toggleRecording') : null"
        data-tip="Toggle Microphone"
        :aria-label="micAriaLabel"
      />
      <img
        :src="props.isTTSEnabled ? speakerIcon : speakerIconInactive"
        class="indicator"
        :class="{ 'mini-ball': isMiniBall }"
        @click="!isConfigState ? emit('togglePlaying') : null"
        data-tip="Toggle Speech Output"
        aria-label="Toggle Speech Output"
      />
      <!-- 迷你球里也保留聊天入口：否则缩下去之后就再也回不到聊天窗口了 -->
      <img
        :src="chatIcon"
        class="indicator"
        @click="!isConfigState ? changeSidebarView('chat') : null"
        data-tip="Toggle Chat Panel"
        aria-label="Toggle Chat Panel"
      />
    </div>
    <div
      class="status-message-container dragable select-none overflow-hidden whitespace-nowrap relative"
      :class="{
        'text-xs': isMiniBall,
        'h-4': isMiniBall,
        'h-6': !isMiniBall,
      }"
    >
      <span
        :id="statusMessageId"
        class="status-message-text absolute"
        :class="{ 'scrolling-text': shouldScrollStatusMessage }"
        :style="statusMessageStyle"
      >
        {{ statusMessage }}
      </span>
      <span
        v-if="shouldScrollStatusMessage"
        class="status-message-text absolute scrolling-text"
        :style="statusMessageStyle"
        aria-hidden="true"
      >
        {{ statusMessage }}
      </span>
    </div>
  </div>

  <template v-if="props.isElectron">
    <!-- 迷你球里也常显：否则缩下去以后找不到回来的按钮 -->
    <div
      class="absolute w-full px-2 flex justify-between z-30 inside-actions"
      :class="{
        'top-[80px]': isMiniBall,
        'top-[220px]': !isMiniBall,
        'inside-actions-visible': isMiniBall,
      }"
    >
      <button
        class="btn btn-circle bg-opacity-20 bg-gray-500 border-0 p-2 btn-indicator-side tooltip tooltip-right"
        data-tip="Take Screenshot"
        aria-label="Take Screenshot"
        :class="{ 'btn-sm': isMiniBall }"
        :style="sideControlStyle"
        @click="!isConfigState ? emit('takeScreenShot') : null"
        :disabled="takingScreenShot"
      >
        <img
          :src="cameraIcon"
          class="indicator indicator-side"
          :class="{ 'mini-ball': isMiniBall }"
          alt=""
        />
      </button>
      <button
        class="btn btn-circle bg-opacity-20 bg-gray-500 border-0 p-2 btn-indicator-side tooltip tooltip-left"
        :data-tip="isMiniBall ? 'Expand avatar ball' : 'Shrink to mini ball'"
        :aria-label="isMiniBall ? 'Expand Avatar Ball' : 'Shrink to Mini Ball'"
        :class="{ 'btn-sm': isMiniBall }"
        :style="sideControlStyle"
        @click="!isConfigState ? toggleMiniBall() : null"
      >
        <img
          :src="isMiniBall ? maxiIcon : miniIcon"
          class="indicator indicator-side"
          :class="{ 'mini-ball': isMiniBall }"
          alt=""
        />
      </button>
    </div>

    <div class="absolute w-full flex justify-center z-30 top-2 inside-actions">
      <div class="dropdown dropdown-hover dropdown-center">
        <button
          tabindex="0"
          role="button"
          aria-label="Application Menu"
          class="btn btn-circle bg-opacity-20 bg-gray-500 border-0 p-2 btn-indicator-side close tooltip tooltip-bottom mb-2"
          :class="{ 'btn-sm': isMiniBall }"
        >
          <img :src="hamburgerIcon" class="indicator indicator-side" alt="" />
        </button>
        <ul
          tabindex="0"
          class="dropdown-content menu bg-base-200 bg-opacity-80 rounded-box z-[1] w-36 p-2 shadow"
        >
          <li>
            <a @click="!isConfigState ? openSettingsWindow() : null"
              >Settings</a
            >
          </li>
          <li><a @click="closeWindow">Close app</a></li>
        </ul>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, defineProps, nextTick, ref, watch, onMounted } from 'vue'
import { useGeneralStore, AudioState } from '../stores/generalStore'
import {
  collapseToAvatar,
  expandToChatWindow,
  shrinkToMiniBall,
} from '../utils/windowModeActions'
import { storeToRefs } from 'pinia'
import {
  micIcon,
  micIconActive,
  speakerIcon,
  speakerIconInactive,
  chatIcon,
  miniIcon,
  maxiIcon,
  cameraIcon,
  hamburgerIcon,
} from '../utils/assetsImport'

const props = defineProps({
  isElectron: {
    type: Boolean,
    default: false,
  },
  isTTSEnabled: {
    type: Boolean,
    required: true,
  },
  audioState: {
    type: String as () => AudioState,
    required: true,
  },
  /** 外层 actions-layer 的缩放系数（头像尺寸 / 480），用于让侧边按钮反向补偿 */
  uiScale: {
    type: Number,
    default: 1,
  },
})

const emit = defineEmits(['takeScreenShot', 'togglePlaying', 'toggleRecording'])

/**
 * 侧边按钮（拍照 / 迷你球开关）跟着头像整体缩放后，在迷你球里只剩 13px，
 * 既看不清也点不中。这里按 1/uiScale 反向补偿，位置锚点不变、视觉尺寸恒定。
 */
const sideControlStyle = computed(() => {
  const scale = props.uiScale > 0 ? props.uiScale : 1
  const counter = Math.min(2, Math.max(1, 1 / scale))
  return { transform: `scale(${counter})`, transformOrigin: 'center center' }
})

const generalStore = useGeneralStore()
const {
  isMiniBall,
  statusMessage,
  openSidebar,
  takingScreenShot,
  sideBarView,
  isRecordingRequested,
  audioState: storeAudioState,
} = storeToRefs(generalStore)

const statusMessageId = ref(
  `status-msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
)

const scrollSpeedFactor = 0.1
const scrollAnimationDuration = ref('10s')

const shouldScrollStatusMessage = computed(() => {
  return statusMessage.value.length > 20
})

const statusMessageStyle = computed(() => {
  if (shouldScrollStatusMessage.value) {
    return {
      'animation-duration': scrollAnimationDuration.value,
    }
  }
  return {}
})

const calculateScrollDuration = () => {
  nextTick(() => {
    const textEl = document.getElementById(statusMessageId.value)
    if (textEl && shouldScrollStatusMessage.value) {
      const textWidth = textEl.offsetWidth
      if (textWidth > 0) {
        const duration = textWidth * scrollSpeedFactor
        scrollAnimationDuration.value = `${Math.max(3, duration).toFixed(2)}s`
      } else {
        scrollAnimationDuration.value = `${(statusMessage.value.length * 0.3 * scrollSpeedFactor * 20).toFixed(2)}s`
      }
    } else if (!shouldScrollStatusMessage.value) {
      scrollAnimationDuration.value = '0s'
    }
  })
}

watch(
  statusMessage,
  () => {
    calculateScrollDuration()
  },
  { immediate: true }
)

watch(isMiniBall, () => {
  calculateScrollDuration()
})

const micIconSrc = computed(() => {
  return props.audioState === 'LISTENING' ||
    (isRecordingRequested.value && props.audioState !== 'IDLE')
    ? micIconActive
    : micIcon
})

const micAriaLabel = computed(() => {
  return isRecordingRequested.value
    ? 'Stop Microphone'
    : 'Start Microphone'
})

const closeWindow = () => {
  if (props.isElectron) {
    ;(window as any).electron.closeApp()
  }
}

const openSettingsWindow = async () => {
  if (window.aliceIPC) {
    try {
      await window.aliceIPC.invoke('settings-window:open')
    } catch (error) {
      console.error('Failed to open settings window:', error)
    }
  }
}

const changeSidebarView = (view: 'chat' | 'settings') => {
  // 两种窗口形态之间切换：头像球点聊天 → 变成正常窗口；正常窗口里再点聊天 → 收回头像球
  if (view === 'chat' && props.isElectron) {
    if (generalStore.windowMode === 'avatar_ball') {
      void expandToChatWindow()
      return
    }
    if (openSidebar.value && sideBarView.value === 'chat') {
      void collapseToAvatar()
      return
    }
  }

  if (sideBarView.value === view && openSidebar.value) {
    toggleSidebar()
  } else if (sideBarView.value !== view || !openSidebar.value) {
    sideBarView.value = view
    if (!openSidebar.value) {
      if (isMiniBall.value) {
        toggleMiniBall()
      }
      toggleSidebar()
    }
  }
}

const toggleSidebar = async () => {
  openSidebar.value = !openSidebar.value
  if (props.isElectron) {
    await nextTick()
    const targetWidth = openSidebar.value ? 1200 : 500
    // 聊天驾驶舱需要更高的面板（消息流 + 输入区 + 审批卡片）
    const targetHeight = openSidebar.value ? 700 : 500
    ;(window as any).electron.resize({
      width: targetWidth,
      height: targetHeight,
    })
  }
}

/**
 * 迷你球开关（avatar 上的 mini 按钮）。
 * 注意：这不是 Windows 的窗口最小化，那个走 window:minimize → win.minimize()。
 */
const toggleMiniBall = async () => {
  // 聊天窗口里按它 = 重建为透明窗口，并且直接落在迷你球尺寸上
  if (generalStore.windowMode === 'window') {
    await shrinkToMiniBall()
    return
  }

  const nextMiniBall = !isMiniBall.value
  isMiniBall.value = nextMiniBall

  if (props.isElectron) {
    await nextTick()

    if (nextMiniBall && openSidebar.value) {
      toggleSidebar()
      openSidebar.value = false
      setTimeout(() => {
        console.log('[MiniBall] Shrink to mini ball after closing the panel.')
        ;(window as any).electron.setMiniBall({ miniBall: true })
      }, 300)
    } else {
      console.log(`[MiniBall] Toggle mini ball: ${nextMiniBall}`)
      ;(window as any).electron.setMiniBall({ miniBall: nextMiniBall })
    }
  }
}

const isConfigState = computed(() => {
  return storeAudioState.value === 'CONFIG'
})

onMounted(() => {
  calculateScrollDuration()
})
</script>

