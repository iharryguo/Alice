/**
 * 工具名 → 中文短标签。用于聊天气泡上的工具徽章与工具卡片标题。
 * 新增工具时在这里补一行即可；未收录的工具会退化为原始名字。
 */
const TOOL_LABELS: Record<string, string> = {
  // 记忆
  save_memory: '写入记忆',
  remember_self_fact: '记住自己的设定',
  delete_memory: '删除记忆',
  recall_memories: '检索记忆',
  // 基础
  get_current_datetime: '查看时间',
  open_path: '打开路径',
  list_directory: '列目录',
  execute_command: '执行命令',
  manage_clipboard: '剪贴板',
  // 网络
  perform_web_search: '联网搜索',
  searxng_web_search: 'SearXNG 搜索',
  browser_context: '浏览器上下文',
  search_torrents: '搜索种子',
  add_torrent_to_qb: '添加下载',
  // 日程 / 邮件
  schedule_task: '创建定时任务',
  manage_scheduled_tasks: '管理定时任务',
  get_calendar_events: '查看日程',
  create_calendar_event: '创建日程',
  update_calendar_event: '更新日程',
  delete_calendar_event: '删除日程',
  search_emails: '搜索邮件',
  get_email_content: '读取邮件',
  // 视觉 / 感知
  take_screenshot: '屏幕截图',
  analyze_screen: '分析屏幕',
  capture_camera: '摄像头拍照',
  analyze_camera: '摄像头分析',
  get_system_status: '系统状态',
  list_windows: '窗口列表',
  // 电脑操作
  type_text: '键入文字',
  press_keys: '按键',
  click_at: '鼠标点击',
  move_mouse: '移动鼠标',
  scroll: '滚动',
  open_application: '启动应用',
  send_notification: '系统通知',
  set_volume: '调整音量',
  lock_screen: '锁屏',
  // 文档
  create_word_document: '生成 Word',
  create_excel_sheet: '生成 Excel',
  read_office_document: '读取文档',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name
}

export const KNOWN_TOOLS = Object.keys(TOOL_LABELS)
