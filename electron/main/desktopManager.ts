import { ipcMain } from 'electron'
import fs from 'fs/promises'
import { exec } from 'child_process'
import {
  commandScope,
  isPreApproved,
  requestApproval,
} from './approvalManager'

class DesktopManager {
  private static instance: DesktopManager | null = null

  constructor() {
    if (DesktopManager.instance) {
      return DesktopManager.instance
    }
    DesktopManager.instance = this
    this.registerIpcHandlers()
  }

  static getInstance(): DesktopManager {
    if (!DesktopManager.instance) {
      DesktopManager.instance = new DesktopManager()
    }
    return DesktopManager.instance
  }

  private registerIpcHandlers() {
    if (ipcMain.listenerCount('desktop:listDirectory') > 0) {
      ipcMain.removeAllListeners('desktop:listDirectory')
    }
    if (ipcMain.listenerCount('desktop:executeCommand') > 0) {
      ipcMain.removeAllListeners('desktop:executeCommand')
    }

    ipcMain.handle('desktop:listDirectory', async (_event, dirPath) => {
      try {
        if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {
          return { success: false, error: 'A directory path is required.' }
        }

        const requestedPath = await fs.realpath(dirPath.trim())
        const stat = await fs.stat(requestedPath)
        if (!stat.isDirectory()) {
          return {
            success: false,
            error: 'The requested path is not a directory.',
          }
        }

        if (!isPreApproved('directory', requestedPath)) {
          const decision = await requestApproval({
            kind: 'directory',
            title: '允许访问这个目录？',
            detail: requestedPath,
            scope: requestedPath,
            fallbackMessage: 'Alice 想要读取这个目录及其子目录。',
          })
          if (decision === 'deny') {
            return { success: false, error: 'Directory access denied by user.' }
          }
        }

        const files = await fs.readdir(requestedPath)
        return { success: true, files }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })

    ipcMain.handle('desktop:executeCommand', async (_event, command: unknown) => {
      if (typeof command !== 'string' || command.trim().length === 0) {
        return { success: false, error: 'A command is required.' }
      }

      if (command.length > 16_000) {
        return { success: false, error: 'Command is too long.' }
      }

      const commandPreview =
        command.length > 4_000
          ? `${command.slice(0, 4_000)}\n\n[Command preview truncated]`
          : command

      const decision = await requestApproval({
        kind: 'command',
        title: '允许执行这条命令？',
        detail: commandPreview,
        scope: commandScope(command),
        fallbackMessage: 'Alice 想要在这台电脑上执行命令。',
      })

      if (decision === 'deny') {
        return { success: false, error: 'Command execution denied by user.' }
      }

      return new Promise(resolve => {
        exec(
          command,
          { timeout: 60_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              resolve({
                success: false,
                error: stderr ? `${error.message}\n${stderr}` : error.message,
              })
              return
            }
            resolve({
              success: true,
              output: stderr ? `${stdout}${stderr}` : stdout,
            })
          }
        )
      })
    })
  }
}

export default DesktopManager
