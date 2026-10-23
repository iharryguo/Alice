import { composeAssistantSystemPrompt } from './composeSystemPrompt'

/**
 * 旧入口，保留给还没迁移的地方用。
 * 新代码请直接调用 composeAssistantSystemPrompt（需要英语模式时传 englishMode）。
 */
export function buildAssistantSystemPrompt(personaPrompt?: string): string {
  return composeAssistantSystemPrompt(personaPrompt, { englishMode: false })
}
