import { CORE_SYSTEM_PROMPT } from './coreSystemPrompt'
import {
  ENGLISH_COACH_RULES,
  ENGLISH_LANGUAGE_LOCK,
} from './englishCoachPrompt'

export interface ComposeSystemPromptOptions {
  englishMode?: boolean
}

/**
 * 系统提示词的唯一拼装入口。
 *
 * 主链路（conversationStore.getComposedSystemPrompt）和上下文动作
 * （chatWithContextAction）都必须走这里，否则两套提示词会再次漂移——
 * 之前 chatWithContextAction 直接调 buildAssistantSystemPrompt，
 * 导致右键菜单触发的对话永远进不了英语模式。
 */
export function composeAssistantSystemPrompt(
  persona?: string,
  options: ComposeSystemPromptOptions = {}
): string {
  const blocks: string[] = []

  // 语言锁必须排在最前面：模型对靠前的硬约束更敏感
  if (options.englishMode) blocks.push(ENGLISH_LANGUAGE_LOCK)

  blocks.push(CORE_SYSTEM_PROMPT.trim())

  const personaText = (persona || '').trim()
  if (personaText) blocks.push(personaText)

  if (options.englishMode) blocks.push(ENGLISH_COACH_RULES)

  return blocks.join('\n\n')
}
