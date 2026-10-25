import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  buildMemoryTranscript,
  createMemorySettler,
  normalizeMemoryKey,
  parseMemoryCandidates,
  selectNewMemories,
  type MemorySettlerDependencies,
  type SettleMessage,
} from '../memorySettler'

const VALID_JSON =
  '[{"content":"用户是国浩律师事务所的律师，主做涉外与跨境案件","memoryType":"personal"}]'

function messages(count: number): SettleMessage[] {
  // 与 chatHistory 一致：最新的在前
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'assistant' : 'user',
    text: index % 2 === 0 ? `回复 ${index}` : `问题 ${index}`,
  }))
}

function buildDependencies(
  overrides: Partial<MemorySettlerDependencies> = {}
): MemorySettlerDependencies {
  return {
    isEnabled: () => true,
    getModel: () => 'deepseek-v4-flash',
    getMessages: () => messages(4),
    getExistingMemories: async () => [],
    complete: async () => VALID_JSON,
    embed: async () => ({ doubao: [0.1, 0.2, 0.3] }),
    saveMemory: async () => true,
    log: () => {},
    minIntervalMs: 0,
    minNewMessages: 2,
    ...overrides,
  }
}

describe('parseMemoryCandidates', () => {
  it('parses a plain JSON array', () => {
    expect(parseMemoryCandidates(VALID_JSON)).toEqual([
      {
        content: '用户是国浩律师事务所的律师，主做涉外与跨境案件',
        memoryType: 'personal',
      },
    ])
  })

  it('tolerates code fences and surrounding chatter', () => {
    const raw = `好的，结果如下：\n\`\`\`json\n${VALID_JSON}\n\`\`\`\n`
    expect(parseMemoryCandidates(raw)).toHaveLength(1)
  })

  it('drops garbage, short entries and unknown memory types', () => {
    const raw = JSON.stringify([
      { content: '太短', memoryType: 'personal' },
      { content: '用户常年在北京工作，习惯用中文交流', memoryType: 'nonsense' },
      { content: '用户偏好简洁直接的回答，不喜欢客套话', memoryType: 'preference' },
      { nope: true },
    ])
    const parsed = parseMemoryCandidates(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].memoryType).toBe('general')
    expect(parsed[1].memoryType).toBe('preference')
  })

  it('returns nothing when the model does not return an array', () => {
    expect(parseMemoryCandidates('没有值得记住的内容')).toEqual([])
    expect(parseMemoryCandidates(null)).toEqual([])
    expect(parseMemoryCandidates('[{"content": ')).toEqual([])
  })
})

describe('selectNewMemories', () => {
  it('skips exact duplicates against existing memories', () => {
    const candidates = [
      { content: '用户是国浩律师事务所的律师', memoryType: 'personal' },
    ]
    expect(
      selectNewMemories(candidates, ['用户是国浩律师事务所的律师。'])
    ).toEqual([])
  })

  it('skips near duplicates that differ only by wording around the same fact', () => {
    const candidates = [
      { content: '用户习惯用中文交流，不喜欢英文回复', memoryType: 'preference' },
    ]
    expect(
      selectNewMemories(candidates, [
        '用户习惯用中文交流，不喜欢英文回复，语气要直接',
      ])
    ).toEqual([])
  })

  it('keeps genuinely new memories and respects the limit', () => {
    const candidates = [
      { content: '用户正在准备英国法院判决书的翻译校正', memoryType: 'project' },
      { content: '用户偏好深色界面与信息密度高的布局', memoryType: 'preference' },
      { content: '用户的个人邮箱是清华校友邮箱', memoryType: 'personal' },
      { content: '用户养了一只叫团子的猫', memoryType: 'personal' },
    ]
    const picked = selectNewMemories(candidates, [], 2)
    expect(picked).toHaveLength(2)
    expect(picked[0].content).toContain('英国法院')
  })
})

describe('buildMemoryTranscript', () => {
  it('drops the oldest messages when the character budget is exceeded', () => {
    const list: SettleMessage[] = [
      { role: 'user', text: '最新的一句话' },
      { role: 'assistant', text: '较早的一句'.repeat(50) },
    ]
    const transcript = buildMemoryTranscript(list, { maxChars: 40 })
    expect(transcript).toContain('最新的一句话')
    expect(transcript).not.toContain('较早的一句')
  })

  it('always keeps at least the newest message', () => {
    const huge = '很长的内容'.repeat(200)
    const transcript = buildMemoryTranscript([{ role: 'user', text: huge }], {
      maxChars: 50,
      perMessage: 30,
    })
    expect(transcript.startsWith('用户：')).toBe(true)
    expect(transcript.length).toBeLessThan(80)
  })
})

describe('createMemorySettler', () => {
  it('does nothing when auto extraction is disabled', async () => {
    const settler = createMemorySettler(
      buildDependencies({ isEnabled: () => false })
    )
    await expect(settler.settle('turn')).resolves.toEqual({
      saved: 0,
      skipped: 'disabled',
    })
  })

  it('extracts one memory and writes it with an embedding', async () => {
    const saved: Array<{ content: string; memoryType: string; dim: number }> = []
    const settler = createMemorySettler(
      buildDependencies({
        saveMemory: async ({ content, memoryType, embedding }) => {
          saved.push({
            content,
            memoryType,
            dim: embedding.doubao?.length ?? 0,
          })
          return true
        },
      })
    )

    await expect(settler.settle('turn')).resolves.toEqual({ saved: 1 })
    expect(saved).toHaveLength(1)
    expect(saved[0].memoryType).toBe('personal')
    expect(saved[0].dim).toBe(3)
  })

  it('asks the model with the memory extraction prompt', async () => {
    const complete = vi.fn(
      async (_input: { systemPrompt: string; model: string }) => VALID_JSON
    )
    const settler = createMemorySettler(buildDependencies({ complete }))
    await settler.settle('turn')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0].systemPrompt).toBe(
      MEMORY_EXTRACTION_SYSTEM_PROMPT
    )
  })

  it('skips a second run when no new messages arrived', async () => {
    const settler = createMemorySettler(buildDependencies())
    await settler.settle('turn')
    await expect(settler.settle('turn')).resolves.toEqual({
      saved: 0,
      skipped: 'nothing-new',
    })
  })

  it('honours the cooldown for forced-free runs', async () => {
    let clock = 1000
    const settler = createMemorySettler(
      buildDependencies({
        minNewMessages: 1,
        minIntervalMs: 60_000,
        now: () => clock,
      })
    )
    await settler.settle('turn')
    clock += 1000
    await expect(settler.settle('turn')).resolves.toEqual({
      saved: 0,
      skipped: 'cooldown',
    })
  })

  it('does not write duplicates already in the memory table', async () => {
    const saveMemory = vi.fn(async () => true)
    const settler = createMemorySettler(
      buildDependencies({
        getExistingMemories: async () => [
          '用户是国浩律师事务所的律师，主做涉外与跨境案件。',
        ],
        saveMemory,
      })
    )
    await expect(settler.settle('turn')).resolves.toEqual({
      saved: 0,
      skipped: 'duplicated',
    })
    expect(saveMemory).not.toHaveBeenCalled()
  })

  it('gives up when the model call times out', async () => {
    const settler = createMemorySettler(
      buildDependencies({
        complete: () => new Promise<string>(() => {}),
      })
    )
    await expect(settler.settle('turn', { timeoutMs: 10 })).resolves.toEqual({
      saved: 0,
      skipped: 'timeout',
    })
  })

  it('returns busy when a previous settle is still running', async () => {
    let release: (value: string) => void = () => {}
    const settler = createMemorySettler(
      buildDependencies({
        complete: () =>
          new Promise<string>(resolve => {
            release = resolve
          }),
      })
    )
    const first = settler.settle('turn')
    await expect(settler.settle('turn')).resolves.toEqual({
      saved: 0,
      skipped: 'busy',
    })
    release(VALID_JSON)
    await first
  })

  it('normalises keys for dedupe regardless of punctuation', () => {
    expect(normalizeMemoryKey('用户，喜欢中文。')).toBe(
      normalizeMemoryKey('用户 喜欢中文')
    )
  })
})
