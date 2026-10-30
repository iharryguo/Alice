import { usePerception } from './usePerception'

/**
 * 截图的旧入口，保留给 Main.vue / Overlay 等既有调用点。
 * 真正的状态与事件绑定都在 usePerception 里（聊天快捷按钮、仪表盘共用同一份）。
 */
export function useScreenshot() {
  const perception = usePerception()

  return {
    screenShot: perception.screenShot,
    screenshotReady: perception.screenshotReady,
    takingScreenShot: perception.takingScreenShot,
    takeScreenShot: perception.captureScreen,
    setupScreenshotListeners: perception.bindScreenshotBridge,
    cleanupScreenshotListeners: perception.unbindScreenshotBridge,
  }
}
