/**
 * 统一日志入口（渲染层）。
 *
 * 设计目标：
 * - 级别：debug / info / warn / error，默认可全部输出；
 * - 来源：每个模块自带模块名（audio / chat / teaching / ipc ...），可按模块单独调级；
 * - 运行时可控：DevTools 里 `__aliceLog.setLevel('warn')` 立刻生效，不必改代码重启；
 * - 全部落盘：主进程按同一份配置写到 logs/alice-YYYY-MM-DD.log，控制台也留一份。
 *
 * 为什么不用 console 了事：出问题时用户往往直接强杀进程，控制台的东西留不下来，
 * 而且没法按模块过滤——一问"刚才那段语音怎么回事"，满屏都是无关输出。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface LoggerConfig {
  /** 全局最低级别 */
  minLevel: LogLevel
  /** 按模块覆盖级别；未列出的模块跟随 minLevel */
  moduleLevels: Record<string, LogLevel>
  /** 完全关闭（只影响落盘与控制台，不影响业务） */
  enabled: boolean
}

const config: LoggerConfig = {
  minLevel: 'debug',
  moduleLevels: {},
  enabled: true,
}

export function configureLogger(patch: Partial<LoggerConfig>): LoggerConfig {
  if (patch.minLevel) config.minLevel = patch.minLevel
  if (patch.moduleLevels) {
    Object.assign(config.moduleLevels, patch.moduleLevels)
  }
  if (typeof patch.enabled === 'boolean') config.enabled = patch.enabled
  return getLoggerConfig()
}

export function getLoggerConfig(): LoggerConfig {
  return {
    minLevel: config.minLevel,
    moduleLevels: { ...config.moduleLevels },
    enabled: config.enabled,
  }
}

export function isLevelEnabled(module: string, level: LogLevel): boolean {
  if (!config.enabled) return false
  const threshold = config.moduleLevels[module] ?? config.minLevel
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[threshold]
}

let sequence = 0

export function logEvent(
  module: string,
  event: string,
  data?: Record<string, unknown>,
  level: LogLevel = 'info'
): void {
  if (!isLevelEnabled(module, level)) return

  sequence += 1
  const payload = {
    level,
    module,
    event,
    seq: sequence,
    data,
  }

  try {
    const line = `[${module}] ${event}`
    if (level === 'error') console.error(line, data ?? '')
    else if (level === 'warn') console.warn(line, data ?? '')
    else console.log(line, data ?? '')

    const bridge = (window as any)?.aliceIPC
    if (bridge?.invoke) {
      bridge
        .invoke('app:log', payload)
        .catch?.((error: unknown) =>
          console.warn('[Logger] 写入失败:', error)
        )
    }
  } catch (error) {
    console.warn('[Logger] 记录失败:', error)
  }
}

/**
 * DevTools 里直接控制，例如：
 *   __aliceLog.setLevel('warn')
 *   __aliceLog.setModuleLevel('audio', 'debug')
 *   __aliceLog.disable()
 */
export function installLogConsoleApi(): void {
  if (typeof window === 'undefined') return
  ;(window as any).__aliceLog = {
    setLevel: (level: LogLevel) => configureLogger({ minLevel: level }),
    setModuleLevel: (module: string, level: LogLevel) =>
      configureLogger({ moduleLevels: { [module]: level } }),
    disable: () => configureLogger({ enabled: false }),
    enable: () => configureLogger({ enabled: true }),
    config: getLoggerConfig,
  }
}
