import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_NAME_FALLBACK_MS,
  DEFAULT_VOICE_NAME_PAUSE_MS,
  DEFAULT_VOICE_TURN_MIN_CHARS,
  PERSONA_SPOKEN_ALIASES,
  decideTurnEnd,
  findPersonaName,
  mergeTurnFragments,
  personaSpokenAliases,
  stripLeadingPersonaAddress,
} from '../voiceTurnGate'

const CJK = /[\u4e00-\u9fff]/

describe('findPersonaName — 命中', () => {
  it('句首的拉丁名字命中且 atStart=true', () => {
    expect(findPersonaName('Alice, how are you', 'alice')).toEqual({
      alias: 'alice',
      atStart: true,
      index: 0,
    })
  })

  it('只有一个名字也命中', () => {
    expect(findPersonaName('alice', 'alice')).toMatchObject({
      alias: 'alice',
      atStart: true,
    })
  })

  it('中文译名命中（含标点）', () => {
    expect(findPersonaName('爱丽丝，帮我看看', 'alice')).toEqual({
      alias: '爱丽丝',
      atStart: true,
      index: 0,
    })
  })

  it('中文译名的变体写法命中', () => {
    expect(findPersonaName('艾丽丝', 'alice')).toMatchObject({
      alias: '艾丽丝',
      atStart: true,
    })
  })

  it('跳过前导语气词后仍算句首命中', () => {
    // "um, hey Felix what's up"：前面只有 um/hey，属于在开头叫人
    expect(findPersonaName("um, hey Felix what's up", 'felix')).toEqual({
      alias: 'felix',
      atStart: true,
      index: 7,
    })
  })

  it('中文语气词后接名字算句首命中', () => {
    expect(findPersonaName('嗯，Alice，你在吗', 'alice')).toMatchObject({
      alias: 'alice',
      atStart: true,
    })
  })

  it('另一人格的中文译名命中（curtis → 柯蒂斯）', () => {
    expect(findPersonaName('柯蒂斯，这个工期', 'curtis')).toEqual({
      alias: '柯蒂斯',
      atStart: true,
      index: 0,
    })
  })

  it('中文名后跟称呼引导词时不算名词短语，仍然命中', () => {
    expect(findPersonaName('爱丽丝帮我看看天气', 'alice')).toMatchObject({
      alias: '爱丽丝',
      atStart: true,
    })
  })

  it('名字出现在句中（不在开头）仍然识别到，但 atStart=false', () => {
    const hit = findPersonaName('I said hey Alice please help', 'alice')
    expect(hit).toMatchObject({ alias: 'alice', atStart: false })
    expect(hit?.index).toBe(11)
  })
})

describe('findPersonaName — 反向误判', () => {
  it('malice 不能命中 alice（词边界）', () => {
    expect(findPersonaName('malice aforethought', 'alice')).toBeNull()
  })

  it('alices 不能命中 alice（后缀是字母）', () => {
    expect(findPersonaName('alices', 'alice')).toBeNull()
  })

  it('“爱丽丝梦游仙境真好看”是名词短语，不命中', () => {
    expect(findPersonaName('爱丽丝梦游仙境真好看', 'alice')).toBeNull()
  })

  it('所有格不是称呼：Alice\'s car 不命中（第 2 轮修复）', () => {
    expect(findPersonaName("Alice's car is red", 'alice')).toBeNull()
  })

  it('名字出现在句子后半段的中文里不命中', () => {
    expect(
      findPersonaName('今天天气不错我想问问爱丽丝这件事', 'alice')
    ).toBeNull()
  })

  it('别人格的名字不会串到当前人格', () => {
    expect(findPersonaName('felix, are you there', 'alice')).toBeNull()
    expect(findPersonaName('Alice, how are you', 'felix')).toBeNull()
    expect(findPersonaName('柯蒂斯，这个工期', 'alice')).toBeNull()
  })

  it('空文本和纯语气词返回 null', () => {
    for (const text of ['', '   ', '嗯嗯', '呃…']) {
      expect(findPersonaName(text, 'alice'), text).toBeNull()
      expect(findPersonaName(text, 'felix'), text).toBeNull()
    }
  })
})

describe('stripLeadingPersonaAddress — 只剥开头称呼', () => {
  it('剥掉开头的英文名字与逗号', () => {
    expect(stripLeadingPersonaAddress('Alice, how are you', 'alice')).toBe(
      'how are you'
    )
  })

  it('剥掉开头已登记的中文译名与全角逗号', () => {
    expect(stripLeadingPersonaAddress('菲利克斯，帮我算下', 'felix')).toBe(
      '帮我算下'
    )
    expect(stripLeadingPersonaAddress('柯蒂斯 这个工期怎么办', 'curtis')).toBe(
      '这个工期怎么办'
    )
  })

  // brief 指定的「费利克斯」曾不在 felix 别名表里（第 1 轮已补，见 test-report.md §5）
  it('「费利克斯」这个音译能被认出也能被剥掉', () => {
    expect(findPersonaName('费利克斯，今天怎么样', 'felix')).not.toBeNull()
    expect(stripLeadingPersonaAddress('费利克斯，今天怎么样', 'felix')).toBe(
      '今天怎么样'
    )
  })

  it('语气词 + 全角标点包住的称呼也能剥掉', () => {
    expect(stripLeadingPersonaAddress('嗯，Alice，你在吗', 'alice')).toBe(
      '你在吗'
    )
    expect(stripLeadingPersonaAddress('hey, Alice, 帮我看看', 'alice')).toBe(
      '帮我看看'
    )
  })

  it('所有格不被当称呼剥掉，原样返回（第 2 轮修复）', () => {
    expect(stripLeadingPersonaAddress("Alice's car is red", 'alice')).toBe(
      "Alice's car is red"
    )
    expect(stripLeadingPersonaAddress('Alice’s car', 'alice')).toBe(
      'Alice’s car'
    )
  })

  it('内容词（名词短语）不会被误剥，原样返回', () => {
    const text = '爱丽丝梦游仙境真好看'
    expect(findPersonaName(text, 'alice')).toBeNull()
    expect(stripLeadingPersonaAddress(text, 'alice')).toBe(text)
  })

  it('剥掉语气词 + 名字 + 标点', () => {
    expect(stripLeadingPersonaAddress("hey Alice what's up", 'alice')).toBe(
      "what's up"
    )
  })

  it('句中提到的名字原样返回，不改坏用户的话', () => {
    expect(stripLeadingPersonaAddress('I told Alice about it', 'alice')).toBe(
      'I told Alice about it'
    )
    expect(
      stripLeadingPersonaAddress('我上次跟柯蒂斯聊过这个', 'curtis')
    ).toBe('我上次跟柯蒂斯聊过这个')
  })

  it('只有称呼时剥成空串（交给 decideTurnEnd 判定不发送）', () => {
    expect(stripLeadingPersonaAddress('Alice', 'alice')).toBe('')
    expect(stripLeadingPersonaAddress('Alice?', 'alice')).toBe('')
  })

  it('空文本原样返回', () => {
    expect(stripLeadingPersonaAddress('', 'alice')).toBe('')
    expect(stripLeadingPersonaAddress('   ', 'alice')).toBe('   ')
  })

  it('不会误剥别的词（alices 不动）', () => {
    expect(stripLeadingPersonaAddress('alices are fruit', 'alice')).toBe(
      'alices are fruit'
    )
  })
})

describe('mergeTurnFragments — 合并顺序与去噪', () => {
  it('按顺序拼接，中文片段之间不插空格', () => {
    expect(mergeTurnFragments(['我想', '问个事'])).toBe('我想问个事')
  })

  it('英文片段之间补一个空格', () => {
    expect(mergeTurnFragments(['Let me check', 'the file'])).toBe(
      'Let me check the file'
    )
  })

  it('空片段被忽略', () => {
    expect(mergeTurnFragments(['', '   ', '我想', '', '问个事'])).toBe(
      '我想问个事'
    )
    expect(mergeTurnFragments([])).toBe('')
    expect(mergeTurnFragments(['', '  '])).toBe('')
  })

  it('首尾空白被裁掉', () => {
    expect(mergeTurnFragments(['  你好  '])).toBe('你好')
  })

  it('连续重复片段只保留一份', () => {
    expect(mergeTurnFragments(['ok', 'ok'])).toBe('ok')
    expect(mergeTurnFragments(['我想问', '我想问', '个事'])).toBe('我想问个事')
  })

  it('非连续重复保留（顺序不被改动）', () => {
    expect(mergeTurnFragments(['a', 'b', 'a'])).toBe('a b a')
  })
})

describe('decideTurnEnd — 命中名字', () => {
  it('命中名字 + 正文够长 + 静音达到阈值 → send，且剥掉开头称呼', () => {
    expect(
      decideTurnEnd({
        fragments: ['Alice, how are you'],
        personaHit: true,
        personaId: 'alice',
        silenceMs: 2100,
      })
    ).toEqual({ action: 'send', text: 'how are you', reason: 'name-hit' })
  })

  it('命中名字但静音不够 → wait', () => {
    expect(
      decideTurnEnd({
        fragments: ['Alice, how are you'],
        personaHit: true,
        personaId: 'alice',
        silenceMs: 1200,
      })
    ).toEqual({ action: 'wait', text: '', reason: 'waiting' })
  })

  it('默认阈值就是 2000ms：1999 等、2000 发', () => {
    const base = {
      fragments: ['Alice 帮我看看'],
      personaHit: true,
      personaId: 'alice',
    }
    expect(DEFAULT_VOICE_NAME_PAUSE_MS).toBe(2000)
    expect(decideTurnEnd({ ...base, silenceMs: 1999 }).action).toBe('wait')
    expect(decideTurnEnd({ ...base, silenceMs: 2000 })).toEqual({
      action: 'send',
      text: '帮我看看',
      reason: 'name-hit',
    })
  })

  it('只叫了一声名字（剥完为空）→ wait，不把问候发出去', () => {
    expect(
      decideTurnEnd({
        fragments: ['Felix?'],
        personaHit: true,
        personaId: 'felix',
        silenceMs: 1000,
      })
    ).toEqual({ action: 'wait', text: '', reason: 'waiting' })
  })

  it('只叫了一声名字且已经等到阈值 → ignore（不是 send）', () => {
    expect(
      decideTurnEnd({
        fragments: ['Felix?'],
        personaHit: true,
        personaId: 'felix',
        silenceMs: 2100,
      })
    ).toEqual({ action: 'ignore', text: '', reason: 'empty' })
  })

  it('不传 personaId 时向后兼容：原样发送未剥称呼的文本', () => {
    expect(
      decideTurnEnd({
        fragments: ['Alice, how are you'],
        personaHit: true,
        silenceMs: 2100,
      })
    ).toEqual({
      action: 'send',
      text: 'Alice, how are you',
      reason: 'name-hit',
    })
  })

  it('多片段合并后剥称呼，顺序不变', () => {
    expect(
      decideTurnEnd({
        fragments: ['Alice 我想', '问个事'],
        personaHit: true,
        personaId: 'alice',
        silenceMs: 2200,
      })
    ).toEqual({ action: 'send', text: '我想问个事', reason: 'name-hit' })
  })

  it('多片段里有空片段也照常合并发送', () => {
    expect(
      decideTurnEnd({
        fragments: ['', 'Alice 我想', '   ', '问个事'],
        personaHit: true,
        personaId: 'alice',
        silenceMs: 2200,
      })
    ).toEqual({ action: 'send', text: '我想问个事', reason: 'name-hit' })
  })

  it('名字在句中时 personaHit 也不剥正文', () => {
    expect(
      decideTurnEnd({
        fragments: ['我上次跟 Alice 说过这个了'],
        personaHit: true,
        personaId: 'alice',
        silenceMs: 2100,
      })
    ).toEqual({
      action: 'send',
      text: '我上次跟 Alice 说过这个了',
      reason: 'name-hit',
    })
  })
})

describe('decideTurnEnd — 未命中名字（兜底）', () => {
  const base = {
    fragments: ['今天天气怎么样'],
    personaHit: false,
  }

  it('静音 2.5s < 10s → wait', () => {
    expect(decideTurnEnd({ ...base, silenceMs: 2500 })).toEqual({
      action: 'wait',
      text: '',
      reason: 'waiting',
    })
  })

  it('默认兜底阈值 10000ms：9999 等、10000 发', () => {
    expect(DEFAULT_VOICE_NAME_FALLBACK_MS).toBe(10000)
    expect(decideTurnEnd({ ...base, silenceMs: 9999 }).action).toBe('wait')
    expect(decideTurnEnd({ ...base, silenceMs: 10000 })).toEqual({
      action: 'send',
      text: '今天天气怎么样',
      reason: 'fallback-silence',
    })
  })

  it('未命中时名字出现在正文里也不会被剥', () => {
    expect(
      decideTurnEnd({
        fragments: ['Alice 这个人挺有意思'],
        personaHit: false,
        personaId: 'alice',
        silenceMs: 10000,
      })
    ).toEqual({
      action: 'send',
      text: 'Alice 这个人挺有意思',
      reason: 'fallback-silence',
    })
  })
})

describe('decideTurnEnd — 空内容与自定义阈值', () => {
  it('没有任何片段 → ignore/empty', () => {
    expect(
      decideTurnEnd({ fragments: [], personaHit: false, silenceMs: 0 })
    ).toEqual({ action: 'ignore', text: '', reason: 'empty' })
    expect(
      decideTurnEnd({ fragments: ['', '  '], personaHit: true, silenceMs: 9999 })
    ).toEqual({ action: 'ignore', text: '', reason: 'empty' })
  })

  it('纯语气词即使超过兜底时间也不发送', () => {
    expect(
      decideTurnEnd({ fragments: ['嗯嗯'], personaHit: false, silenceMs: 12000 })
    ).toEqual({ action: 'ignore', text: '', reason: 'empty' })
  })

  it('正文不足 minChars 时视为空（默认 2 字）', () => {
    expect(DEFAULT_VOICE_TURN_MIN_CHARS).toBe(2)
    expect(
      decideTurnEnd({
        fragments: ['Alice 好'],
        personaHit: true,
        personaId: 'alice',
        silenceMs: 2100,
      })
    ).toEqual({ action: 'ignore', text: '', reason: 'empty' })
  })

  it('自定义 minChars 生效', () => {
    expect(
      decideTurnEnd({
        fragments: ['好的'],
        personaHit: false,
        silenceMs: 10000,
        minChars: 4,
      })
    ).toEqual({ action: 'ignore', text: '', reason: 'empty' })
  })

  it('自定义 namePauseMs 生效', () => {
    const base = {
      fragments: ['Alice 帮我看看天气'],
      personaHit: true,
      personaId: 'alice',
      namePauseMs: 3000,
    }
    expect(decideTurnEnd({ ...base, silenceMs: 2999 })).toEqual({
      action: 'wait',
      text: '',
      reason: 'waiting',
    })
    expect(decideTurnEnd({ ...base, silenceMs: 3000 })).toEqual({
      action: 'send',
      text: '帮我看看天气',
      reason: 'name-hit',
    })
  })

  it('自定义 fallbackSilenceMs 生效', () => {
    const base = {
      fragments: ['今天天气不错'],
      personaHit: false,
      fallbackSilenceMs: 5000,
    }
    expect(decideTurnEnd({ ...base, silenceMs: 4999 })).toEqual({
      action: 'wait',
      text: '',
      reason: 'waiting',
    })
    expect(decideTurnEnd({ ...base, silenceMs: 5000 })).toEqual({
      action: 'send',
      text: '今天天气不错',
      reason: 'fallback-silence',
    })
  })

  it('自定义阈值下，未命中名字也不会借用 namePauseMs', () => {
    // 没叫名字就不该按 2s 结束，必须等兜底阈值
    expect(
      decideTurnEnd({
        fragments: ['今天天气不错'],
        personaHit: false,
        namePauseMs: 2000,
        fallbackSilenceMs: 10000,
        silenceMs: 2500,
      })
    ).toEqual({ action: 'wait', text: '', reason: 'waiting' })
  })
})

describe('别名完整性', () => {
  const builtInPersonas = ['alice', 'felix', 'curtis']

  it('alice / felix / curtis 都登记在别名表里', () => {
    for (const id of builtInPersonas) {
      expect(PERSONA_SPOKEN_ALIASES[id], id).toBeDefined()
    }
  })

  it('每个人格至少有 1 个拉丁别名和 1 个中文别名', () => {
    for (const id of builtInPersonas) {
      const aliases = personaSpokenAliases(id)
      const latin = aliases.filter(alias => !CJK.test(alias))
      const cjk = aliases.filter(alias => CJK.test(alias))
      expect(latin.length, `${id} 缺拉丁别名`).toBeGreaterThan(0)
      expect(cjk.length, `${id} 缺中文别名`).toBeGreaterThan(0)
    }
  })

  it('别名表里没有空串', () => {
    for (const id of builtInPersonas) {
      for (const alias of personaSpokenAliases(id)) {
        expect(alias.length, id).toBeGreaterThan(0)
      }
    }
  })

  it('未知人格缺别名表时不抛异常，退回显式空表', () => {
    expect(() => personaSpokenAliases('no-such-persona')).not.toThrow()
    expect(personaSpokenAliases('no-such-persona')).toEqual([])
  })

  it('未知人格用 displayName 小写兜底匹配', () => {
    expect(personaSpokenAliases('novapersona', 'Nova')).toEqual(['nova'])
    expect(findPersonaName('Nova, 你好', 'novapersona', 'Nova')).toMatchObject({
      alias: 'nova',
      atStart: true,
    })
  })

  it('displayName 兜底也能走通 decideTurnEnd 的剥称呼', () => {
    expect(
      decideTurnEnd({
        fragments: ['Nova 帮我看看'],
        personaHit: true,
        personaId: 'novapersona',
        personaDisplayName: 'Nova',
        silenceMs: 2100,
      })
    ).toEqual({ action: 'send', text: '帮我看看', reason: 'name-hit' })
  })

  it('displayName 与别名重复时不会重复登记', () => {
    const aliases = personaSpokenAliases('alice', 'Alice')
    expect(aliases.filter(alias => alias === 'alice')).toHaveLength(1)
    expect(aliases).toHaveLength(PERSONA_SPOKEN_ALIASES.alice.length)
  })
})
