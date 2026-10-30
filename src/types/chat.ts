export interface AppChatMessageContentPart {
  type:
    | 'app_text'
    | 'app_image_uri'
    | 'app_generated_image_path'
    | 'app_file'
    | 'app_error'
  text?: string
  uri?: string
  path?: string
  absolutePathForOpening?: string
  imageGenerationId?: string
  isPartial?: boolean
  partialIndex?: number
  fileId?: string
  fileName?: string
  isScheduledReminder?: boolean
  taskName?: string
  timestamp?: string
  errorType?: string
  errorCode?: string
  errorParam?: string
  originalError?: any
}

export interface ChatMessage {
  id?: string
  local_id_temp?: string
  api_message_id?: string
  api_response_id?: string
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool'
  content: string | AppChatMessageContentPart[]
  tool_call_id?: string
  name?: string
  tool_calls?: any[]
  created_at?: number
  content_summary?: string
  /** 用户这条来自语音还是打字；决定气泡上要不要挂「语音」标记 */
  channel?: 'voice' | 'text'
  /**
   * 这条不是用户问出来的，而是 Alice 自己开口的
   * （定时任务/提醒等主动送达的消息），界面上标成「主动关心」。
   */
  isProactive?: boolean
}
