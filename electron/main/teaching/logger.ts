import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 主进程侧的日志落盘。
 *
 * 一次运行一个文件：文件名精确到秒（alice-2026-10-25_17-23-06.log），
 * 程序启动时创建，本次运行期间一直追加，下次启动再开一个。
 *
 * 这样看日志时不存在"这份文件里混着三次运行、哪些 bug 已经修好"的问题：
 * 最新的一份就是最近一次运行，旧文件直接忽略即可。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level?: LogLevel
  module?: string
  event: string
  seq?: number
  data?: Record<string, unknown>
}

/** 启动时刻固定在模块加载时，之后不再变化——它就是这次运行的身份 */
const runStartedAt = new Date()

/** 保留最近 30 次运行的日志，再早的自动清理 */
const MAX_LOG_FILES = 30

const RUN_FILE_PATTERN = /^alice-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/

let queue: Promise<void> = Promise.resolve()
let initialized: Promise<void> | null = null

export function appLogDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本次运行的标识，形如 2026-10-25_17-23-06 */
export function appLogRunId(): string {
  const date = runStartedAt
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours()
  )}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

export function appLogPath(): string {
  return path.join(appLogDir(), `alice-${appLogRunId()}.log`)
}

/** 兼容旧名字：界面上的"打开日志"仍然用得到 */
export function teachingLogDir(): string {
  return appLogDir()
}

export function teachingLogPath(): string {
  return appLogPath()
}

function formatTime(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
    at.getHours()
  )}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${String(
    at.getMilliseconds()
  ).padStart(3, '0')}`
}

function serialize(data: unknown): string {
  if (data === undefined) return ''
  try {
    return ' ' + JSON.stringify(data)
  } catch {
    return ' [unserializable]'
  }
}

function line(entry: Required<Pick<LogEntry, 'level' | 'module'>> & LogEntry): string {
  return `[${formatTime()}] ${entry.level.toUpperCase().padEnd(5)} ${
    entry.module
  } ${entry.event}${serialize(entry.data)}\n`
}

/** 只删本模块自己生成的运行日志，其它文件一概不动 */
async function pruneOldLogs(): Promise<void> {
  try {
    const dir = appLogDir()
    const files = await fs.readdir(dir)
    const mine = files.filter(name => RUN_FILE_PATTERN.test(name)).sort()
    // 文件名按时间排序即按时间先后，留下最近的若干个
    const stale = mine.slice(0, Math.max(0, mine.length - MAX_LOG_FILES))
    await Promise.all(
      stale.map(name => fs.unlink(path.join(dir, name)).catch(() => undefined))
    )
  } catch {
    // 清理失败不影响写日志
  }
}

/**
 * 启动时调用一次：建目录、写首行、清理旧文件。
 * 重复调用安全，只会执行一次。
 */
export function initAppLog(meta?: Record<string, unknown>): Promise<void> {
  if (initialized) return initialized

  initialized = (async () => {
    await fs.mkdir(appLogDir(), { recursive: true })
    await fs.appendFile(
      appLogPath(),
      line({
        level: 'info',
        module: 'app',
        event: 'session.start',
        data: {
          run: appLogRunId(),
          startedAt: runStartedAt.toISOString(),
          ...meta,
        },
      }),
      'utf-8'
    )
    await pruneOldLogs()
  })().catch(error => {
    console.error('[Logger] 初始化日志失败:', error)
  })

  return initialized
}

export function flushTeachingLog(): Promise<void> {
  return queue
}

export function writeAppLog(entry: LogEntry): void {
  const payload = {
    level: entry.level ?? 'info',
    module: entry.module ?? 'app',
    event: entry.event,
    seq: entry.seq,
    data: entry.data,
  }

  const text = line(payload as any)

  queue = queue
    .then(async () => {
      await initAppLog()
      await fs.appendFile(appLogPath(), text, 'utf-8')
    })
    .catch(error => {
      console.error('[Logger] 写入失败:', error)
    })
}

/** 兼容课堂日志旧调用 */
export function writeTeachingLog(
  event: string,
  data?: Record<string, unknown>
): void {
  writeAppLog({ module: 'teaching', event, data })
}
