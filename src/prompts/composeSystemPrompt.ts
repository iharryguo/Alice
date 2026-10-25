import { CORE_SYSTEM_PROMPT } from './coreSystemPrompt'
import {
  ENGLISH_COACH_RULES,
  ENGLISH_LANGUAGE_LOCK,
} from './englishCoachPrompt'
import { buildPersonaPrompt, getPersona } from './personas'

export interface ComposeSystemPromptOptions {
  englishMode?: boolean
  /** 当前身份（alice / felix…），决定"对面是谁" */
  personaId?: string
  /** 这个身份在以往对话里即兴确立、并被记住的细节 */
  personaNotes?: string[]
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

  // 身份底稿 + 已确立细节 + 用户自己的补充设定。
  // 底稿始终在：否则切到新人身份后，模型会退回一个没有来历的通用助手。
  blocks.push(
    buildPersonaPrompt(getPersona(options.personaId), {
      notes: options.personaNotes,
      extra: persona,
    })
  )

  if (options.englishMode) blocks.push(ENGLISH_COACH_RULES)

  return blocks.join('\n\n')
}
