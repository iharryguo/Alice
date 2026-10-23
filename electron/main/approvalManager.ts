import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { loadSettings, saveSettings } from './settingsManager'
import { getMainWindow } from './windowManager'

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny'
export type ApprovalKind = 'command' | 'directory' | 'other'

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

export interface ApprovalRequestInput {
  kind: ApprovalKind
  title: string
  detail: string
  /** 用于记忆授权的标识：命令名或目录路径 */
  scope?: string
  /** 内联卡片没有响应时，回退到系统弹窗的话术 */
  fallbackMessage?: string
}

const APPROVAL_FILE_NAME = 'alice-approvals.json'
const RENDERER_ACK_TIMEOUT_MS = 2500
const INLINE_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

const pending = new Map<string, PendingApproval>()
const ackTimers = new Map<string, NodeJS.Timeout>()

let sessionApprovedCommands = new Set<string>()
let sessionApprovedDirectories = new Set<string>()
let permanentApprovedCommands = new Set<string>()
let permanentApprovedDirectories = new Set<string>()
let loaded = false
let handlersRegistered = false

function approvalsFilePath(): string {
  return path.join(app.getPath('userData'), APPROVAL_FILE_NAME)
}

async function loadPermanentDirectories(): Promise<string[]> {
  try {
    const raw = await fs.readFile(approvalsFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as { directories?: unknown }
    if (!Array.isArray(parsed.directories)) return []
    return parsed.directories.filter(
      (item): item is string => typeof item === 'string' && item.length > 0
    )
  } catch {
    return []
  }
}

async function savePermanentDirectories(): Promise<void> {
  try {
    await fs.writeFile(
      approvalsFilePath(),
      JSON.stringify(
        { directories: [...permanentApprovedDirectories] },
        null,
        2
      ),
      { encoding: 'utf-8', mode: 0o600 }
    )
  } catch (error) {
    console.error('[Approval] 保存目录授权失败:', error)
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const settings = await loadSettings()
    permanentApprovedCommands = new Set(
      (settings?.approvedCommands || [])
        .filter((item): item is string => typeof item === 'string')
        .map(item => normalizeScope(item))
        .filter(Boolean)
    )
  } catch (error) {
    console.warn('[Approval] 读取设置中的已授权命令失败:', error)
  }
  permanentApprovedDirectories = new Set(
    (await loadPermanentDirectories()).map(item => normalizeScope(item))
  )
}

function normalizeScope(scope: string): string {
  return String(scope || '').trim().replace(/[\\/]+$/, '').toLowerCase()
}

/** 命令授权按可执行文件名记忆，与设置页的「已授权命令」保持一致 */
export function commandScope(command: string): string {
  const first = String(command || '')
    .trim()
    .split(/\s+/)[0]
  return first ? path.basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '') : ''
}

export function isPreApproved(kind: ApprovalKind, scope?: string): boolean {
  if (!scope) return false
  const key = normalizeScope(scope)
  if (!key) return false

  if (kind === 'directory') {
    if (sessionApprovedDirectories.has(key)) return true
    return [...permanentApprovedDirectories].some(
      root => key === root || key.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
    )
  }

  return sessionApprovedCommands.has(key) || permanentApprovedCommands.has(key)
}

async function rememberAlways(
  kind: ApprovalKind,
  scope: string
): Promise<void> {
  const key = normalizeScope(scope)
  if (!key) return

  if (kind === 'directory') {
    permanentApprovedDirectories.add(key)
    await savePermanentDirectories()
    return
  }

  permanentApprovedCommands.add(key)
  try {
    const settings = (await loadSettings()) || {}
    const existing = new Set(
      (settings.approvedCommands || []).filter(
        (item): item is string => typeof item === 'string'
      )
    )
    if (![...existing].some(item => normalizeScope(item) === key)) {
      existing.add(key)
      await saveSettings({ ...settings, approvedCommands: [...existing] })
    }
  } catch (error) {
    console.error('[Approval] 保存永久命令授权失败:', error)
  }
}

async function showNativeDialog(
  request: ApprovalRequestInput,
  owner: Electron.BrowserWindow | null
): Promise<ApprovalDecision> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '仅本次', '本次会话', '永久允许'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: request.title,
    message: request.fallbackMessage || request.title,
    detail: request.detail,
  }
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)

  switch (result.response) {
    case 1:
      return 'once'
    case 2:
      return 'session'
    case 3:
      return 'always'
    default:
      return 'deny'
  }
}

/**
 * 请求一次授权。优先走渲染进程的内联审批卡片；
 * 渲染进程 2.5 秒内没有 ack（比如窗口还没准备好）则回退到系统弹窗，
 * 避免主进程被一个永远不会回来的 Promise 挂死。
 */
export async function requestApproval(
  request: ApprovalRequestInput
): Promise<ApprovalDecision> {
  await ensureLoaded()

  if (request.scope && isPreApproved(request.kind, request.scope)) {
    return 'session'
  }

  const win = getMainWindow()
  const canUseInline =
    !!win && !win.isDestroyed() && !win.webContents.isDestroyed()

  if (!canUseInline) {
    const decision = await showNativeDialog(request, win)
    await applyDecision(request, decision)
    return decision
  }

  if (win!.isMinimized()) win!.restore()
  win!.show()

  const id = randomUUID()
  const decision = await new Promise<ApprovalDecision>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id)
      ackTimers.delete(id)
      resolve('deny')
    }, INLINE_APPROVAL_TIMEOUT_MS)

    pending.set(id, { resolve, timer })

    const ackTimer = setTimeout(async () => {
      ackTimers.delete(id)
      if (!pending.has(id)) return
      // 渲染进程没有接住这个请求，改用系统弹窗
      pending.delete(id)
      clearTimeout(timer)
      const nativeDecision = await showNativeDialog(request, win)
      resolve(nativeDecision)
    }, RENDERER_ACK_TIMEOUT_MS)
    ackTimers.set(id, ackTimer)

    try {
      win!.webContents.send('approval:request', {
        id,
        kind: request.kind,
        title: request.title,
        detail: request.detail,
        scope: request.scope,
      })
    } catch (error) {
      console.error('[Approval] 无法向渲染进程发送审批请求:', error)
      pending.delete(id)
      clearTimeout(timer)
      clearTimeout(ackTimer)
      ackTimers.delete(id)
      resolve('deny')
    }
  })

  const ackTimer = ackTimers.get(id)
  if (ackTimer) {
    clearTimeout(ackTimer)
    ackTimers.delete(id)
  }

  await applyDecision(request, decision)
  return decision
}

async function applyDecision(
  request: ApprovalRequestInput,
  decision: ApprovalDecision
): Promise<void> {
  if (!request.scope) return
  const key = normalizeScope(request.scope)

  if (decision === 'session') {
    if (request.kind === 'directory') sessionApprovedDirectories.add(key)
    else sessionApprovedCommands.add(key)
    return
  }

  if (decision === 'always') {
    if (request.kind === 'directory') {
      permanentApprovedDirectories.add(key)
      await savePermanentDirectories()
    } else {
      await rememberAlways(request.kind, request.scope)
    }
  }
}

export function registerApprovalHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.handle('approval:ack', (_event, payload) => {
    const id = String(payload?.id || '')
    const timer = ackTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      ackTimers.delete(id)
    }
    return { success: true, known: pending.has(id) }
  })

  ipcMain.handle('approval:respond', (_event, payload) => {
    const id = String(payload?.id || '')
    const decision = String(payload?.decision || 'deny') as ApprovalDecision
    const entry = pending.get(id)
    if (!entry) return { success: false, error: '审批请求已过期' }

    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(
      decision === 'once' ||
        decision === 'session' ||
        decision === 'always' ||
        decision === 'deny'
        ? decision
        : 'deny'
    )
    return { success: true }
  })
}
