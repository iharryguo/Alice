import * as cron from 'node-cron'
import { randomUUID } from 'node:crypto'
import { getDBInstance } from './thoughtVectorStore'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { commandScope, isPreApproved, requestApproval } from './approvalManager'

const execAsync = promisify(exec)

export interface ScheduledTask {
  id: string
  name: string
  cronExpression: string
  actionType: 'command' | 'reminder'
  details: string
  isActive: boolean
  createdAt: string
  lastRun?: string
  nextRun?: string
}

const activeCronJobs = new Map<string, cron.ScheduledTask>()

/**
 * Initialize the scheduler database table
 */
export function initializeSchedulerDB(): void {
  const db = getDBInstance()

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK (action_type IN ('command', 'reminder')),
      details TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_run TEXT,
      next_run TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_active ON scheduled_tasks (is_active);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks (next_run);
  `)

  console.log('[SchedulerManager] Database table initialized')
}

/**
 * Load all active tasks from database and schedule them
 */
export async function loadAndScheduleAllTasks(): Promise<void> {
  const db = getDBInstance()

  try {
    const activeTasks = db
      .prepare('SELECT * FROM scheduled_tasks WHERE is_active = 1')
      .all() as Array<{
      id: string
      name: string
      cron_expression: string
      action_type: string
      details: string
      is_active: number
      created_at: string
      last_run: string | null
      next_run: string | null
    }>

    console.log(`[SchedulerManager] Loading ${activeTasks.length} active tasks`)

    for (const task of activeTasks) {
      const scheduledTask: ScheduledTask = {
        id: task.id,
        name: task.name,
        cronExpression: task.cron_expression,
        actionType: task.action_type as 'command' | 'reminder',
        details: task.details,
        isActive: task.is_active === 1,
        createdAt: task.created_at,
        lastRun: task.last_run || undefined,
        nextRun: task.next_run || undefined,
      }

      await scheduleTask(scheduledTask, false)
    }

    console.log('[SchedulerManager] All active tasks loaded and scheduled')
  } catch (error) {
    console.error('[SchedulerManager] Failed to load tasks:', error)
  }
}

/**
 * Schedule a single task
 */
export async function scheduleTask(
  task: ScheduledTask,
  saveToDb: boolean = true
): Promise<boolean> {
  try {
    if (!cron.validate(task.cronExpression)) {
      console.error(
        `[SchedulerManager] Invalid cron expression: ${task.cronExpression}`
      )
      return false
    }

    // 同一个 task id 只能有一个 cron job。重复调度（加载两次、切换状态、
    // 修改后重排）时先销毁旧 job，否则两条定时器同时跑，提醒会重复触发。
    const existingJob = activeCronJobs.get(task.id)
    if (existingJob) {
      existingJob.stop()
      existingJob.destroy()
      activeCronJobs.delete(task.id)
    }

    const cronJob = cron.createTask(
      task.cronExpression,
      async () => {
        console.log(`[SchedulerManager] Executing task: ${task.name}`)
        await executeTask(task)

        const now = new Date().toISOString()
        updateTaskLastRun(task.id, now)
      },
      {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }
    )

    cronJob.start()

    activeCronJobs.set(task.id, cronJob)

    if (saveToDb) {
      await saveTaskToDb(task)
    }

    console.log(
      `[SchedulerManager] Task scheduled: ${task.name} (${task.cronExpression})`
    )
    return true
  } catch (error) {
    console.error(
      `[SchedulerManager] Failed to schedule task ${task.name}:`,
      error
    )
    return false
  }
}

/**
 * 把一条系统消息送进当前窗口（提醒、任务失败、权限被撤销都走这里）
 */
async function notifyRenderer(message: string, taskName: string): Promise<void> {
  const { webContents } = await import('electron')
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) {
      wc.send('scheduler:reminder', {
        taskId: `system-${Date.now()}`,
        taskName,
        message,
        timestamp: new Date().toISOString(),
      })
    }
  }
}

/**
 * Execute a scheduled task
 */
async function executeTask(task: ScheduledTask): Promise<void> {
  try {
    if (task.actionType === 'command') {
      // 定时命令和即时命令走同一套授权：授权在创建任务时取得，
      // 每次执行前再核对一次，撤销后不得继续跑。
      const scope = commandScope(task.details)
      if (!isPreApproved('command', scope)) {
        console.warn(
          `[SchedulerManager] Command task "${task.name}" skipped: no approval for ${scope}`
        )
        await notifyRenderer(
          `定时任务「${task.name}」因为命令 ${scope || task.details} 未获授权，这次没有执行。`,
          '定时任务已跳过'
        )
        return
      }

      console.log(`[SchedulerManager] Executing command: ${task.details}`)
      const { stdout, stderr } = await execAsync(task.details)

      if (stderr) {
        console.warn(`[SchedulerManager] Command stderr: ${stderr}`)
      }
      if (stdout) {
        console.log(`[SchedulerManager] Command stdout: ${stdout}`)
      }
    } else if (task.actionType === 'reminder') {
      console.log(`[SchedulerManager] Sending reminder: ${task.details}`)
      await notifyRenderer(task.details, task.name)
    }
  } catch (error) {
    console.error(
      `[SchedulerManager] Failed to execute task ${task.name}:`,
      error
    )
    await notifyRenderer(
      `定时任务「${task.name}」执行失败：${(error as Error).message}`,
      '定时任务失败'
    ).catch(() => {})
  }
}

/**
 * Save task to database
 */
async function saveTaskToDb(task: ScheduledTask): Promise<void> {
  const db = getDBInstance()

  try {
    const stmt = db.prepare(`
      INSERT INTO scheduled_tasks 
      (id, name, cron_expression, action_type, details, is_active, created_at, last_run, next_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      task.id,
      task.name,
      task.cronExpression,
      task.actionType,
      task.details,
      task.isActive ? 1 : 0,
      task.createdAt,
      task.lastRun || null,
      task.nextRun || null
    )

    console.log(`[SchedulerManager] Task saved to database: ${task.id}`)
  } catch (error) {
    console.error('[SchedulerManager] Failed to save task to database:', error)
    throw error
  }
}

/**
 * Update task's last run time
 */
function updateTaskLastRun(taskId: string, lastRun: string): void {
  const db = getDBInstance()

  try {
    const stmt = db.prepare(
      'UPDATE scheduled_tasks SET last_run = ? WHERE id = ?'
    )
    stmt.run(lastRun, taskId)
  } catch (error) {
    console.error('[SchedulerManager] Failed to update last run time:', error)
  }
}

/**
 * Create a new scheduled task
 */
export async function createScheduledTask(
  name: string,
  cronExpression: string,
  actionType: 'command' | 'reminder',
  details: string
): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    if (actionType === 'command') {
      // 定时命令会在后台无人值守执行，必须在创建时明确授权，
      // 不能像以前那样直接 execAsync 绕过审批。
      const scope = commandScope(details)
      const decision = await requestApproval({
        kind: 'command',
        scope,
        title: '定时任务要执行命令',
        detail: `任务名称：${name}\n执行计划：${cronExpression}\n命令：${details}`,
        fallbackMessage: `允许定时任务「${name}」执行命令吗？`,
      })

      if (decision === 'deny') {
        return { success: false, error: '用户未授权该定时命令' }
      }
    }

    const task: ScheduledTask = {
      id: randomUUID(),
      name,
      cronExpression,
      actionType,
      details,
      isActive: true,
      createdAt: new Date().toISOString(),
    }

    const success = await scheduleTask(task, true)

    if (success) {
      return { success: true, taskId: task.id }
    } else {
      return { success: false, error: 'Failed to schedule task' }
    }
  } catch (error) {
    console.error('[SchedulerManager] Failed to create task:', error)
    return { success: false, error: String(error) }
  }
}

/**
 * Get all scheduled tasks
 */
export function getAllScheduledTasks(): ScheduledTask[] {
  const db = getDBInstance()

  try {
    const tasks = db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
      .all() as Array<{
      id: string
      name: string
      cron_expression: string
      action_type: string
      details: string
      is_active: number
      created_at: string
      last_run: string | null
      next_run: string | null
    }>

    return tasks.map(task => ({
      id: task.id,
      name: task.name,
      cronExpression: task.cron_expression,
      actionType: task.action_type as 'command' | 'reminder',
      details: task.details,
      isActive: task.is_active === 1,
      createdAt: task.created_at,
      lastRun: task.last_run || undefined,
      nextRun: task.next_run || undefined,
    }))
  } catch (error) {
    console.error('[SchedulerManager] Failed to get tasks:', error)
    return []
  }
}

/**
 * Delete a scheduled task
 */
export async function deleteScheduledTask(taskId: string): Promise<boolean> {
  try {
    const cronJob = activeCronJobs.get(taskId)
    if (cronJob) {
      cronJob.stop()
      cronJob.destroy()
      activeCronJobs.delete(taskId)
    }

    const db = getDBInstance()
    const stmt = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?')
    const result = stmt.run(taskId)

    if (result.changes > 0) {
      console.log(`[SchedulerManager] Task deleted: ${taskId}`)
      return true
    } else {
      console.log(`[SchedulerManager] Task not found: ${taskId}`)
      return false
    }
  } catch (error) {
    console.error('[SchedulerManager] Failed to delete task:', error)
    return false
  }
}

/**
 * Toggle task active status
 */
export async function toggleTaskStatus(taskId: string): Promise<boolean> {
  try {
    const db = getDBInstance()

    const task = db
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get(taskId) as any
    if (!task) {
      return false
    }

    const newStatus = task.is_active === 1 ? 0 : 1

    const stmt = db.prepare(
      'UPDATE scheduled_tasks SET is_active = ? WHERE id = ?'
    )
    stmt.run(newStatus, taskId)

    const cronJob = activeCronJobs.get(taskId)
    if (newStatus === 1) {
      if (!cronJob) {
        const scheduledTask: ScheduledTask = {
          id: task.id,
          name: task.name,
          cronExpression: task.cron_expression,
          actionType: task.action_type,
          details: task.details,
          isActive: true,
          createdAt: task.created_at,
          lastRun: task.last_run || undefined,
          nextRun: task.next_run || undefined,
        }
        await scheduleTask(scheduledTask, false)
      }
    } else {
      if (cronJob) {
        cronJob.stop()
        cronJob.destroy()
        activeCronJobs.delete(taskId)
      }
    }

    console.log(
      `[SchedulerManager] Task ${taskId} ${newStatus === 1 ? 'activated' : 'deactivated'}`
    )
    return true
  } catch (error) {
    console.error('[SchedulerManager] Failed to toggle task status:', error)
    return false
  }
}

/**
 * Shutdown all scheduled tasks
 */
export function shutdownScheduler(): void {
  console.log('[SchedulerManager] Shutting down scheduler...')

  for (const [taskId, cronJob] of activeCronJobs) {
    try {
      cronJob.stop()
      cronJob.destroy()
      console.log(`[SchedulerManager] Stopped task: ${taskId}`)
    } catch (error) {
      console.error(`[SchedulerManager] Error stopping task ${taskId}:`, error)
    }
  }

  activeCronJobs.clear()
  console.log('[SchedulerManager] Scheduler shutdown complete')
}
