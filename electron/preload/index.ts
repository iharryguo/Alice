import { contextBridge, ipcRenderer } from 'electron'
import {
  isAllowedEventChannel,
  isAllowedInvokeChannel,
  isAllowedSendChannel,
} from './ipcBridgePolicy'

type IpcListener = (...args: any[]) => void
type IpcListenerWrapper = (...args: any[]) => void

const listenerWrappers = new Map<
  string,
  Map<IpcListener, IpcListenerWrapper[]>
>()

function assertAllowedChannel(
  channel: string,
  isAllowed: (channel: string) => boolean,
  operation: string
): void {
  if (typeof channel !== 'string' || !isAllowed(channel)) {
    throw new Error(`Blocked IPC ${operation} channel: ${String(channel)}`)
  }
}

function rememberListenerWrapper(
  channel: string,
  listener: IpcListener,
  wrapper: IpcListenerWrapper
): void {
  let channelListeners = listenerWrappers.get(channel)
  if (!channelListeners) {
    channelListeners = new Map()
    listenerWrappers.set(channel, channelListeners)
  }

  const wrappers = channelListeners.get(listener) ?? []
  wrappers.push(wrapper)
  channelListeners.set(listener, wrappers)
}

function forgetListenerWrapper(
  channel: string,
  listener: IpcListener
): IpcListenerWrapper | undefined {
  const channelListeners = listenerWrappers.get(channel)
  const wrappers = channelListeners?.get(listener)
  const wrapper = wrappers?.pop()

  if (wrappers && wrappers.length === 0) {
    channelListeners?.delete(listener)
  }
  if (channelListeners && channelListeners.size === 0) {
    listenerWrappers.delete(channel)
  }

  return wrapper
}

const aliceIPC = {
  on(channel: string, listener: IpcListener) {
    assertAllowedChannel(channel, isAllowedEventChannel, 'event')
    if (typeof listener !== 'function') {
      throw new TypeError('IPC event listener must be a function')
    }
    const wrapper: IpcListenerWrapper = (_event, ...args) => listener(...args)
    rememberListenerWrapper(channel, listener, wrapper)
    ipcRenderer.on(channel, wrapper)
  },
  off(channel: string, listener: IpcListener) {
    assertAllowedChannel(channel, isAllowedEventChannel, 'event')
    const wrapper = forgetListenerWrapper(channel, listener)
    if (wrapper) {
      ipcRenderer.off(channel, wrapper)
    }
  },
  removeAllListeners(channel: string) {
    assertAllowedChannel(channel, isAllowedEventChannel, 'event')
    ipcRenderer.removeAllListeners(channel)
    listenerWrappers.delete(channel)
  },
  send(channel: string, ...args: any[]) {
    assertAllowedChannel(channel, isAllowedSendChannel, 'send')
    return ipcRenderer.send(channel, ...args)
  },
  invoke(channel: string, ...args: any[]) {
    assertAllowedChannel(channel, isAllowedInvokeChannel, 'invoke')
    return ipcRenderer.invoke(channel, ...args)
  },
}

contextBridge.exposeInMainWorld('electron', {
  resize: (dimensions: { width: number; height: number }) =>
    ipcRenderer.send('resize', dimensions),
  setMiniBall: (payload: { miniBall: boolean }) =>
    ipcRenderer.send('window:mini-ball', payload),
  screenshot: () => ipcRenderer.send('screenshot'),
  showOverlay: () => ipcRenderer.send('show-overlay'),
  getScreenshot: () => ipcRenderer.send('get-screenshot'),
  closeApp: () => ipcRenderer.send('close-app'),
  setWindowMode: (mode: 'ball' | 'window') =>
    aliceIPC.invoke('window:set-mode', { mode }),
  getWindowMode: () => aliceIPC.invoke('window:get-mode'),
  setIgnoreMouseEvents: (ignore: boolean) =>
    aliceIPC.invoke('window:set-ignore-mouse', { ignore }),
  minimize: () => aliceIPC.invoke('window:minimize'),
  toggleMaximize: () => aliceIPC.invoke('window:toggle-maximize'),
  isMaximized: () => aliceIPC.invoke('window:is-maximized'),
  closeWindow: () => aliceIPC.invoke('window:close'),
  onMaximizedChanged: (callback: (maximized: boolean) => void) => {
    const listener = (maximized: boolean) => callback(maximized)
    aliceIPC.on('window:maximized-changed', listener)
    return () => aliceIPC.off('window:maximized-changed', listener)
  },
})

// --------- Expose a narrow, allowlisted API to the Renderer process ---------
contextBridge.exposeInMainWorld('aliceIPC', aliceIPC)

contextBridge.exposeInMainWorld('settingsAPI', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: any) =>
    ipcRenderer.invoke('settings:save', settings),
})

contextBridge.exposeInMainWorld('electronPaths', {
  getRendererDistPath: () => ipcRenderer.invoke('get-renderer-dist-path'),
})

contextBridge.exposeInMainWorld('httpAPI', {
  request: (args: {
    url: string
    method?: string
    headers?: Record<string, string>
    params?: Record<string, any>
    data?: any
    timeout?: number
  }) => ipcRenderer.invoke('http:request', args),
})

contextBridge.exposeInMainWorld('customToolsAPI', {
  list: () => ipcRenderer.invoke('custom-tools:list'),
  refresh: () => ipcRenderer.invoke('custom-tools:list'),
  replaceJson: (rawJson: string) =>
    ipcRenderer.invoke('custom-tools:replace-json', { rawJson }),
  uploadScript: (fileName: string, data: ArrayBuffer | Uint8Array) =>
    ipcRenderer.invoke('custom-tools:upload-script', {
      fileName,
      buffer: data,
    }),
  upsert: (tool: any) => ipcRenderer.invoke('custom-tools:upsert', tool),
  toggle: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('custom-tools:toggle', { id, enabled }),
  delete: (id: string) => ipcRenderer.invoke('custom-tools:delete', { id }),
  execute: (name: string, args?: Record<string, any>) =>
    ipcRenderer.invoke('custom-tools:execute', { name, args }),
})

contextBridge.exposeInMainWorld('customAvatarsAPI', {
  list: () => ipcRenderer.invoke('custom-avatars:list'),
  refresh: () => ipcRenderer.invoke('custom-avatars:refresh'),
})

contextBridge.exposeInMainWorld('desktopAPI', {
  listDirectory: (dirPath: string) =>
    aliceIPC.invoke('desktop:listDirectory', dirPath),
  executeCommand: (command: string) =>
    aliceIPC.invoke('desktop:executeCommand', command),
})

// --------- Preload scripts loading ---------
function domReady(
  condition: DocumentReadyState[] = ['complete', 'interactive']
) {
  return new Promise(resolve => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
      document.addEventListener('screenshot-saved', () => {
        console.log('resolver')
        resolve(true)
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

function useLoading() {
  const className = `loaders-css__square-spin`
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle)
      safeDOM.remove(document.body, oDiv)
    },
  }
}

// ----------------------------------------------------------------------

const { removeLoading } = useLoading()
domReady()

window.onmessage = ev => {
  ev.data.payload === 'removeLoading' && removeLoading()
}
