import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { toCloneable } from '../teachingService'

describe('toCloneable', () => {
  it('strips Vue reactive proxies so IPC can clone the payload', () => {
    const form = reactive({
      targetDurationMin: 25,
      strictness: 'standard',
      wanderThreshold: { windowMinutes: 3, strikes: 2 },
    })

    // 直接克隆代理会抛 DataCloneError，这正是第二次开课点了没反应的原因
    expect(() => structuredClone(form)).toThrow()

    const plain = toCloneable(form)
    expect(plain).toEqual({
      targetDurationMin: 25,
      strictness: 'standard',
      wanderThreshold: { windowMinutes: 3, strikes: 2 },
    })
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('passes through null and undefined unchanged', () => {
    expect(toCloneable(null)).toBeNull()
    expect(toCloneable(undefined)).toBeUndefined()
  })
})
