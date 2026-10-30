import { storeToRefs } from 'pinia'
import { useGeneralStore } from '../stores/generalStore'
import { useObservationStore } from '../stores/observationStore'
import { logEvent } from '../utils/logger'

/**
 * 手动感知：聊天框下方的「看屏幕 / 看摄像头 / 语音说话」三个入口，
 * 以及仪表盘里的快捷测试，都走这里。
 *
 * 拍下来的画面不直接发请求，而是挂在 store 上等待下一条消息
 * （与截图工具的既有行为一致）：用户可以先补一句"帮我看下这个报错"。
 */

type IpcListener = (...args: any[]) => void

let screenshotListenersBound = false
let capturedListener: IpcListener | null = null
let closedListener: IpcListener | null = null

function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.aliceIPC
}

/** 等视频轨道真正出画面，避免拍到一张全黑 */
function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('摄像头画面超时'))
    }, 6000)

    const done = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      window.clearTimeout(timer)
      video.removeEventListener('loadeddata', done)
      video.removeEventListener('canplay', done)
    }

    video.addEventListener('loadeddata', done, { once: true })
    video.addEventListener('canplay', done, { once: true })
  })
}

export function usePerception() {
  const generalStore = useGeneralStore()
  const observationStore = useObservationStore()
  const {
    screenShot,
    screenshotReady,
    cameraShot,
    cameraShotReady,
    takingScreenShot,
    cameraCaptureBusy,
    isRecordingRequested,
  } = storeToRefs(generalStore)

  /**
   * 屏幕：走已有的遮罩选区流程（用户自己框选要给我看的部分），
   * 结果由主进程通过 screenshot-captured 事件回传。
   */
  const captureScreen = async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !window.electron) {
      generalStore.statusMessage = '截图只在桌面端可用'
      return false
    }
    if (takingScreenShot.value) return false

    generalStore.clearPendingScreenshot()
    takingScreenShot.value = true
    generalStore.statusMessage = '正在截屏…'
    try {
      await window.aliceIPC.invoke('show-overlay')
      logEvent('perception', 'screen.requested')
      return true
    } catch (error) {
      console.error('[Perception] 触发截屏失败:', error)
      takingScreenShot.value = false
      generalStore.statusMessage = 'Error: 无法开始截屏'
      return false
    }
  }

  /** 摄像头：抓一帧静态画面，用完立刻关掉轨道（不留常驻摄像头） */
  const captureCamera = async (): Promise<boolean> => {
    if (cameraCaptureBusy.value) return false
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      generalStore.statusMessage = 'Error: 当前环境不支持摄像头'
      return false
    }

    cameraCaptureBusy.value = true
    generalStore.statusMessage = '正在拍照…'
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      video.playsInline = true
      await video.play().catch(() => undefined)
      await waitForVideoReady(video)

      const width = video.videoWidth || 1280
      const height = video.videoHeight || 720
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建画布')
      context.drawImage(video, 0, 0, width, height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)

      generalStore.setPendingCameraShot(dataUrl)
      observationStore.observe('camera', `拍了一张摄像头画面 ${width}×${height}`)
      generalStore.statusMessage = '摄像头画面已拍下'
      logEvent('perception', 'camera.captured', { width, height })
      return true
    } catch (error: any) {
      const message = error?.name === 'NotAllowedError'
        ? '摄像头权限被拒绝'
        : error?.name === 'NotFoundError'
          ? '没有找到摄像头'
          : error?.message || '摄像头不可用'
      console.warn('[Perception] 拍照失败:', error)
      generalStore.statusMessage = `Error: ${message}`
      logEvent('perception', 'camera.failed', { message }, 'warn')
      return false
    } finally {
      stream?.getTracks().forEach(track => track.stop())
      cameraCaptureBusy.value = false
    }
  }

  /** 语音：只是想说话就打开麦克风，已经在听就关掉 */
  const toggleVoice = (): boolean => {
    generalStore.toggleRecordingRequest()
    const listening = generalStore.isRecordingRequested
    observationStore.observe('audio', listening ? '打开麦克风，开始聆听' : '关闭麦克风')
    logEvent('perception', 'mic.toggled', { listening })
    return listening
  }

  /**
   * 主进程截图完成 → 写进 store。
   * 注册是全局一次的：Main / 仪表盘 / 聊天面板都可能在，重复注册会重复处理同一张图。
   */
  const bindScreenshotBridge = () => {
    if (screenshotListenersBound || !hasBridge()) return
    screenshotListenersBound = true

    capturedListener = async () => {
      try {
        const dataURI = await window.aliceIPC.invoke('get-screenshot')
        if (dataURI) {
          generalStore.setPendingScreenshot(dataURI)
          generalStore.statusMessage = '截图已就绪，随下一条消息发送'
          observationStore.observe('screen', '手动截取了一张屏幕画面')
        } else {
          generalStore.statusMessage = 'Error: 截到一张空图'
        }
      } catch (error) {
        console.error('[Perception] 读取截图失败:', error)
        generalStore.statusMessage = 'Error: 读取截图失败'
      }
    }

    closedListener = () => {
      takingScreenShot.value = false
      window.aliceIPC?.invoke('focus-main-window')
    }

    window.aliceIPC.on('screenshot-captured', capturedListener)
    window.aliceIPC.on('overlay-closed', closedListener)
  }

  const unbindScreenshotBridge = () => {
    if (!screenshotListenersBound || !hasBridge()) return
    if (capturedListener) {
      window.aliceIPC.off('screenshot-captured', capturedListener)
    }
    if (closedListener) {
      window.aliceIPC.off('overlay-closed', closedListener)
    }
    capturedListener = null
    closedListener = null
    screenshotListenersBound = false
  }

  return {
    screenShot,
    screenshotReady,
    cameraShot,
    cameraShotReady,
    takingScreenShot,
    cameraCaptureBusy,
    isRecordingRequested,
    captureScreen,
    captureCamera,
    toggleVoice,
    clearScreenShot: generalStore.clearPendingScreenshot,
    clearCameraShot: generalStore.clearPendingCameraShot,
    bindScreenshotBridge,
    unbindScreenshotBridge,
  }
}
