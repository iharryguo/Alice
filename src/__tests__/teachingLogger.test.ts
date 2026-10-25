import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const userDataDir = mkdtempSync(path.join(tmpdir(), 'alice-run-log-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getVersion: () => '0.0.0-test',
  },
}))

import {
  appLogRunId,
  flushTeachingLog,
  teachingLogPath,
  writeAppLog,
  writeTeachingLog,
} from '../../electron/main/teaching/logger'

describe('run-scoped logger', () => {
  beforeAll(() => {
    // 文件名精确到秒：一次运行一个文件，看日志时按文件名就能判断是哪一次
    expect(teachingLogPath()).toMatch(
      /alice-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/
    )
    expect(appLogRunId()).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/)
  })

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('writes a session header once, then one line per event', async () => {
    writeTeachingLog('lesson.start', { course: 'Families', nodes: 5 })
    writeTeachingLog('teacher.say', { text: 'Look at this picture.' })
    writeAppLog({ module: 'teaching', event: 'stage.page', data: { page: 3 } })

    await flushTeachingLog()

    const content = readFileSync(teachingLogPath(), 'utf-8')
    const lines = content.trim().split('\n')

    // 首行是本次运行的身份，后面才是业务日志
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('session.start')
    expect(lines[0]).toContain(appLogRunId())

    // 格式：时间 + 级别 + 模块 + 事件
    expect(lines[1]).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] INFO\s+teaching lesson\.start/
    )
    expect(lines[1]).toContain('"course":"Families"')
    expect(lines[2]).toContain('teacher.say')
    expect(lines[3]).toContain('"page":3')
  })

  it('keeps writing to the same file for the whole run', async () => {
    const before = teachingLogPath()
    writeTeachingLog('lesson.finish', { nodes: 1 })
    await flushTeachingLog()

    expect(teachingLogPath()).toBe(before)
  })
})
