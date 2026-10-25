import { logEvent, type LogLevel } from '../../utils/logger'

/**
 * 课堂日志的语义入口：统一走全局 logger，模块名固定为 teaching。
 * 这样课堂事件与音频、聊天事件落在同一份文件里，按时间能对齐。
 */
export function logLesson(
  event: string,
  data?: Record<string, unknown>,
  level: LogLevel = 'info'
): void {
  logEvent('teaching', event, data, level)
}
