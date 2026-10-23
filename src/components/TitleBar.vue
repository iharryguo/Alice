<template>
  <!-- 自绘标题栏：窗口是永久无边框的（见 windowManager.ts），聊天窗口形态
       由这根 32px 的条子承担系统标题栏的职责。
       不用 -webkit-app-region: drag —— 那种"系统拖动区"在 Windows 上是残废的：
       双击不最大化、拖到屏幕边缘不贴靠、右键系统菜单里最大化还是灰的。
       这里和头像拖动同一套手动机制，行为对齐系统标题栏：
       - 按住拖动 = 移动窗口；拖到屏幕上/左/右边缘松手 = 最大化/半屏贴靠
       - 处于最大化/贴靠状态时按住拖动 = 先还原到之前的尺寸再继续拖（Windows 语义）
       - 双击空白处 = 最大化 / 向下还原
       - 右键 = 自绘系统菜单（最小化/最大化/关闭） -->
  <div
    ref="barRef"
    class="titlebar"
    @pointerdown="onPointerDown"
    @dblclick="onDoubleClick"
    @contextmenu.prevent="onContextMenu"
  >
    <span class="titlebar-app">Alice</span>
    <div class="titlebar-controls" @pointerdown.stop @dblclick.stop>
      <button class="tb-btn" title="最小化" aria-label="最小化" @click="minimize">
        <svg viewBox="0 0 10 10" width="10" height="10">
          <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button
        class="tb-btn"
        :title="maximized ? '向下还原' : '最大化'"
        :aria-label="maximized ? '向下还原' : '最大化'"
        @click="toggleMaximize"
      >
        <svg v-if="!maximized" viewBox="0 0 10 10" width="10" height="10">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
        <svg v-else viewBox="0 0 10 10" width="10" height="10">
          <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" />
          <polyline points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button class="tb-btn tb-close" title="关闭" aria-label="关闭" @click="hideToTray">
        <svg viewBox="0 0 10 10" width="10" height="10">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1" />
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>

    <!-- 自绘系统菜单（右键弹出），对齐原生标题栏菜单的最小集合 -->
    <div
      v-if="menuOpen"
      class="tb-menu"
      :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
      @pointerdown.stop
      @dblclick.stop
      @contextmenu.prevent.stop
    >
      <button class="tb-menu-item" @click="menuMinimize">
        <span class="tb-menu-icon">─</span>最小化(N)
      </button>
      <button class="tb-menu-item" @click="menuToggleMaximize">
        <span class="tb-menu-icon">❐</span>{{ maximized ? '向下还原(R)' : '最大化(X)' }}
      </button>
      <div class="tb-menu-sep"></div>
      <button class="tb-menu-item tb-menu-close" @click="menuHideToTray">
        <span class="tb-menu-icon">✕</span>关闭(C)
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'

const maximized = ref(false)
let disposeMaximizedListener: (() => void) | null = null

// ── 拖拽状态 ──
// 坐标全部用 screenX/screenY（与主进程 setBounds 同一坐标系）。
// 拖动中 rAF 循环把"起始窗口位置 + 光标位移"发给主进程；松手时若位移超过
// 阈值则通知主进程做边缘贴靠判定（点击不拖不触发贴靠）。
const barRef = ref<HTMLElement | null>(null)
const DRAG_SNAP_THRESHOLD = 6
let dragging = false
// 位移超过阈值才算真的在拖；超过那一刻才通知主进程（最大化/贴靠状态下
// 这一步会把窗口还原到之前的尺寸）。单击（无位移）不能有任何副作用。
let dragBegan = false
let dragBaseWindowPos = { x: 0, y: 0 }
let dragStartCursor = { x: 0, y: 0 }
let dragLastCursor = { x: 0, y: 0 }
let dragLastSentPos = { x: NaN, y: NaN }
let dragRafId: number | null = null

const applyDragFrame = () => {
  dragRafId = null
  if (!dragging) return
  const x = Math.round(dragBaseWindowPos.x + (dragLastCursor.x - dragStartCursor.x))
  const y = Math.round(dragBaseWindowPos.y + (dragLastCursor.y - dragStartCursor.y))
  if (x !== dragLastSentPos.x || y !== dragLastSentPos.y) {
    dragLastSentPos = { x, y }
    void window.aliceIPC?.invoke('window:set-position', { x, y })
  }
  dragRafId = requestAnimationFrame(applyDragFrame)
}

// 位移第一次超过阈值才真正开始拖：通知主进程（最大化/贴靠状态下这一步
// 会把窗口还原到之前的尺寸并放到光标下），然后启动 rAF 循环跟手。
const beginDrag = async () => {
  try {
    const result = await window.electron?.dragBegin?.({ ...dragLastCursor })
    if (result && dragging) {
      dragBaseWindowPos = { x: result.x, y: result.y }
    }
  } catch (error) {
    console.warn('[TitleBar] 拖拽开始处理失败:', error)
    dragBaseWindowPos = { x: 0, y: 0 }
  }
  if (dragging && dragRafId === null) {
    dragRafId = requestAnimationFrame(applyDragFrame)
  }
}

const onPointerMove = (event: PointerEvent) => {
  dragLastCursor = { x: event.screenX, y: event.screenY }
  if (!dragBegan) {
    const moved =
      Math.abs(event.screenX - dragStartCursor.x) +
      Math.abs(event.screenY - dragStartCursor.y)
    if (moved <= DRAG_SNAP_THRESHOLD) return
    dragBegan = true
    void beginDrag()
    return
  }
  if (dragRafId === null) {
    dragRafId = requestAnimationFrame(applyDragFrame)
  }
}

const onPointerUp = async (event: PointerEvent) => {
  if (!dragging) return
  dragging = false
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId)
    dragRafId = null
  }
  detachDragListeners()
  // 单击（位移没超过阈值）：什么都不做，双击交给 dblclick 处理
  if (!dragBegan) return
  dragBegan = false
  try {
    await window.electron?.dragEnd?.({ x: event.screenX, y: event.screenY })
  } catch (error) {
    console.warn('[TitleBar] 拖拽结束处理失败:', error)
  }
}

const onPointerCancel = () => {
  dragging = false
  dragBegan = false
  if (dragRafId !== null) {
    cancelAnimationFrame(dragRafId)
    dragRafId = null
  }
  detachDragListeners()
}

function attachDragListeners() {
  barRef.value?.addEventListener('pointermove', onPointerMove)
  barRef.value?.addEventListener('pointerup', onPointerUp)
  barRef.value?.addEventListener('pointercancel', onPointerCancel)
}

function detachDragListeners() {
  barRef.value?.removeEventListener('pointermove', onPointerMove)
  barRef.value?.removeEventListener('pointerup', onPointerUp)
  barRef.value?.removeEventListener('pointercancel', onPointerCancel)
}

const onPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) return
  if ((event.target as HTMLElement).closest('.tb-btn, .tb-menu')) return

  // 先占住指针：后续 move/up 即使移出窗口也继续派发到标题栏
  // （合成事件或指针已失效时会抛错，吞掉即可，不影响拖拽本身）
  try {
    barRef.value?.setPointerCapture(event.pointerId)
  } catch {
    /* ignore */
  }
  event.preventDefault()

  // 按下只做记录，不动窗口 —— 窗口在位移超过阈值的那一刻才开始跟手
  dragging = true
  dragBegan = false
  dragStartCursor = { x: event.screenX, y: event.screenY }
  dragLastCursor = { ...dragStartCursor }
  dragLastSentPos = { x: NaN, y: NaN }
  attachDragListeners()
}

const onDoubleClick = (event: MouseEvent) => {
  if ((event.target as HTMLElement).closest('.tb-btn, .tb-menu')) return
  toggleMaximize()
}

// ── 右键菜单 ──
const menuOpen = ref(false)
const menuPos = reactive({ x: 0, y: 0 })

const closeMenu = () => {
  menuOpen.value = false
  window.removeEventListener('pointerdown', onGlobalPointerDown, true)
  window.removeEventListener('blur', closeMenu)
  window.removeEventListener('keydown', onMenuKeydown, true)
}

const onGlobalPointerDown = (event: PointerEvent) => {
  const target = event.target as HTMLElement
  if (!target.closest('.tb-menu')) closeMenu()
}

const onMenuKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') closeMenu()
}

const onContextMenu = (event: MouseEvent) => {
  if ((event.target as HTMLElement).closest('.tb-btn, .tb-menu')) return
  menuPos.x = event.clientX
  // 菜单高约 110px，靠近屏幕底部时向上弹
  menuPos.y = Math.min(event.clientY, window.innerHeight - 130)
  menuOpen.value = true
  window.addEventListener('pointerdown', onGlobalPointerDown, true)
  window.addEventListener('blur', closeMenu)
  window.addEventListener('keydown', onMenuKeydown, true)
}

// ── 窗口控制 ──
const minimize = () => {
  closeMenu()
  window.electron?.minimize?.()
}

const toggleMaximize = () => {
  closeMenu()
  window.electron?.toggleMaximize?.()
}

/** 与系统标题栏 ✕ 同语义：托盘可用就收进托盘，不退出程序 */
const hideToTray = () => {
  closeMenu()
  window.electron?.hideToTray?.()
}

const menuMinimize = minimize
const menuToggleMaximize = toggleMaximize
const menuHideToTray = hideToTray

onMounted(async () => {
  try {
    const result = await window.electron?.isMaximized?.()
    if (result && typeof result.maximized === 'boolean') {
      maximized.value = result.maximized
    }
  } catch (error) {
    console.warn('[TitleBar] 读取最大化状态失败:', error)
  }
  disposeMaximizedListener =
    window.electron?.onMaximizedChanged?.(value => {
      maximized.value = value
    }) ?? null
})

onUnmounted(() => {
  closeMenu()
  onPointerCancel()
  disposeMaximizedListener?.()
  disposeMaximizedListener = null
})
</script>

<style scoped>
.titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 32px;
  z-index: 40;
  display: flex;
  align-items: center;
  background: rgb(15 23 42 / 0.92);
  border-bottom: 1px solid rgb(148 163 184 / 0.12);
  user-select: none;
}

.titlebar-app {
  padding-left: 12px;
  font-size: 12px;
  font-weight: 600;
  color: rgb(203 213 225);
  letter-spacing: 0.02em;
  pointer-events: none;
}

.titlebar-controls {
  margin-left: auto;
  display: flex;
  align-self: stretch;
}

.tb-btn {
  width: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgb(203 213 225);
  background: transparent;
  border: none;
  cursor: default;
}

.tb-btn:hover {
  background: rgb(148 163 184 / 0.18);
  color: rgb(241 245 249);
}

.tb-btn:active {
  background: rgb(148 163 184 / 0.28);
}

.tb-close:hover {
  background: rgb(220 38 38);
  color: rgb(255 255 255);
}

.tb-close:active {
  background: rgb(185 28 28);
}

/* 右键系统菜单 */
.tb-menu {
  position: fixed;
  z-index: 50;
  min-width: 168px;
  padding: 4px;
  background: rgb(15 23 42);
  border: 1px solid rgb(148 163 184 / 0.25);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.45);
  display: flex;
  flex-direction: column;
}

.tb-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: rgb(226 232 240);
  font-size: 12px;
  text-align: left;
  cursor: default;
}

.tb-menu-item:hover {
  background: rgb(148 163 184 / 0.18);
}

.tb-menu-icon {
  width: 14px;
  text-align: center;
  color: rgb(148 163 184);
  font-size: 10px;
}

.tb-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: rgb(148 163 184 / 0.2);
}

.tb-menu-close:hover {
  background: rgb(220 38 38);
  color: rgb(255 255 255);
}
</style>
