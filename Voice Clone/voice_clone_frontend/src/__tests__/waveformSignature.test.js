/**
 * waveformSignature.test.js — 驗證 agent 波形人格簽章的決定性與範圍
 */

import { describe, it, expect } from 'vitest'
import {
  getWaveformSignature,
  WAVEFORM_PRESETS,
  applyEmotionSignal,
  lerpSignatureTowards,
} from '../utils/waveformSignature'

const FIELD_BOUNDS = {
  frequency: [0.4, 3.0],
  amplitude: [0.1, 0.6],
  waveHeight: [0.4, 1.0],
  waveformShape: [0, 1],
}

function expectWithinBounds(signature) {
  Object.entries(FIELD_BOUNDS).forEach(([field, [min, max]]) => {
    expect(signature[field]).toBeGreaterThanOrEqual(min)
    expect(signature[field]).toBeLessThanOrEqual(max)
  })
  expect(signature.hue).toBeGreaterThanOrEqual(0)
  expect(signature.hue).toBeLessThan(360)
}

describe('getWaveformSignature', () => {
  it('同一個 agent_id 每次呼叫都得到完全相同的結果（純函式、決定性）', () => {
    const agent = { agent_id: 'agent-xiaoming', display_name: '小明' }
    const first = getWaveformSignature(agent)
    const second = getWaveformSignature({ ...agent })
    expect(second).toEqual(first)
  })

  it('回傳的五個維度都落在合理範圍內', () => {
    const agents = [
      { agent_id: 'agent-a' },
      { agent_id: 'agent-b' },
      { agent_id: 'agent-c' },
      { agent_id: 'agent-completely-different-id-xyz' },
    ]
    agents.forEach((agent) => expectWithinBounds(getWaveformSignature(agent)))
  })

  it('不同 agent_id 通常會得到不同的簽章（至少不會全部一樣）', () => {
    const signatures = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e'].map((id) =>
      getWaveformSignature({ agent_id: id }),
    )
    const serialized = signatures.map((s) => JSON.stringify(s))
    const uniqueCount = new Set(serialized).size
    expect(uniqueCount).toBeGreaterThan(1)
  })

  it('presetName 一定是 WAVEFORM_PRESETS 裡其中一個原型的名字', () => {
    const signature = getWaveformSignature({ agent_id: 'agent-check-preset' })
    const presetNames = WAVEFORM_PRESETS.map((p) => p.name)
    expect(presetNames).toContain(signature.presetName)
  })

  it('agent 帶有 waveform_signature 覆寫欄位時，直接採用、略過 preset 挑選邏輯', () => {
    const override = {
      frequency: 1.23,
      amplitude: 0.33,
      waveHeight: 0.77,
      waveformShape: 0.5,
      hue: 180,
    }
    const agent = { agent_id: 'agent-with-override', waveform_signature: override }
    expect(getWaveformSignature(agent)).toBe(override)
  })

  it('沒有 agent_id 也沒有 display_name 時不會拋例外，回傳落在範圍內的預設值', () => {
    expect(() => getWaveformSignature({})).not.toThrow()
    expectWithinBounds(getWaveformSignature({}))
    expectWithinBounds(getWaveformSignature(null))
  })

  it('只有 display_name（沒有 agent_id）時一樣是決定性的', () => {
    const first = getWaveformSignature({ display_name: '阿德' })
    const second = getWaveformSignature({ display_name: '阿德' })
    expect(second).toEqual(first)
  })
})

const BASE_SIGNATURE = {
  presetName: '沉穩',
  frequency: 1.0,
  amplitude: 0.3,
  waveHeight: 0.8,
  waveformShape: 0.3,
  hue: 200,
}

describe('applyEmotionSignal', () => {
  it('沒有情緒訊號（undefined/null）時原封不動回傳基準簽章', () => {
    expect(applyEmotionSignal(BASE_SIGNATURE, undefined)).toBe(BASE_SIGNATURE)
    expect(applyEmotionSignal(BASE_SIGNATURE, null)).toBe(BASE_SIGNATURE)
  })

  it('把 frequency/amplitude/waveformShape/hue 的 delta 疊加到基準簽章上', () => {
    const emotion = { frequencyDelta: 0.3, amplitudeDelta: 0.05, shapeDelta: 0.1, hueDelta: 10 }
    const result = applyEmotionSignal(BASE_SIGNATURE, emotion)
    expect(result.frequency).toBeCloseTo(1.3, 5)
    expect(result.amplitude).toBeCloseTo(0.35, 5)
    expect(result.waveformShape).toBeCloseTo(0.4, 5)
    expect(result.hue).toBe(210)
  })

  it('絕對不改動 waveHeight（波高代表主導程度，是角色一直以來的特質，不隨單輪情緒變化）', () => {
    const emotion = { frequencyDelta: 1, amplitudeDelta: 1, shapeDelta: 1, hueDelta: 100 }
    const result = applyEmotionSignal(BASE_SIGNATURE, emotion)
    expect(result.waveHeight).toBe(BASE_SIGNATURE.waveHeight)
  })

  it('疊加後的結果仍然會 clamp 在合理範圍內，不會因為極端情緒訊號跑出邊界', () => {
    const extremeEmotion = { frequencyDelta: 100, amplitudeDelta: 100, shapeDelta: 100, hueDelta: 0 }
    const result = applyEmotionSignal(BASE_SIGNATURE, extremeEmotion)
    expect(result.frequency).toBeLessThanOrEqual(3.0)
    expect(result.amplitude).toBeLessThanOrEqual(0.6)
    expect(result.waveformShape).toBeLessThanOrEqual(1)

    const negativeEmotion = { frequencyDelta: -100, amplitudeDelta: -100, shapeDelta: -100, hueDelta: 0 }
    const negResult = applyEmotionSignal(BASE_SIGNATURE, negativeEmotion)
    expect(negResult.frequency).toBeGreaterThanOrEqual(0.4)
    expect(negResult.amplitude).toBeGreaterThanOrEqual(0.1)
    expect(negResult.waveformShape).toBeGreaterThanOrEqual(0)
  })

  it('hue 會被包成 0~359 之間（跨過 360 邊界時會 wrap 回來）', () => {
    const result = applyEmotionSignal({ ...BASE_SIGNATURE, hue: 355 }, { hueDelta: 10 })
    expect(result.hue).toBe(5)
  })

  it('未提供的 delta 欄位視為 0（不改動對應維度）', () => {
    const result = applyEmotionSignal(BASE_SIGNATURE, { frequencyDelta: 0.2 })
    expect(result.frequency).toBeCloseTo(1.2, 5)
    expect(result.amplitude).toBe(BASE_SIGNATURE.amplitude)
    expect(result.waveformShape).toBe(BASE_SIGNATURE.waveformShape)
    expect(result.hue).toBe(BASE_SIGNATURE.hue)
  })
})

describe('lerpSignatureTowards', () => {
  const target = {
    presetName: '果斷主導',
    frequency: 2.0,
    amplitude: 0.5,
    waveHeight: 1.0,
    waveformShape: 0.8,
    hue: 300,
  }

  it('rate=0 時完全不移動（回傳值等於 current 的各欄位）', () => {
    const result = lerpSignatureTowards(BASE_SIGNATURE, target, 0)
    expect(result.frequency).toBe(BASE_SIGNATURE.frequency)
    expect(result.amplitude).toBe(BASE_SIGNATURE.amplitude)
    expect(result.waveHeight).toBe(BASE_SIGNATURE.waveHeight)
    expect(result.waveformShape).toBe(BASE_SIGNATURE.waveformShape)
    expect(result.hue).toBe(BASE_SIGNATURE.hue)
  })

  it('rate=1 時直接跳到 target 的各欄位', () => {
    const result = lerpSignatureTowards(BASE_SIGNATURE, target, 1)
    expect(result.frequency).toBe(target.frequency)
    expect(result.amplitude).toBe(target.amplitude)
    expect(result.waveHeight).toBe(target.waveHeight)
    expect(result.waveformShape).toBe(target.waveformShape)
    expect(result.hue).toBe(target.hue)
  })

  it('rate 介於 0~1 時每個欄位都各自往 target 移動一部分，不超過 target', () => {
    const result = lerpSignatureTowards(BASE_SIGNATURE, target, 0.25)
    expect(result.frequency).toBeGreaterThan(BASE_SIGNATURE.frequency)
    expect(result.frequency).toBeLessThan(target.frequency)
    expect(result.waveHeight).toBeGreaterThan(BASE_SIGNATURE.waveHeight)
    expect(result.waveHeight).toBeLessThan(target.waveHeight)
  })

  it('反覆呼叫會讓每個欄位持續逼近 target（跟 waveformPath.js 的 lerpTowards 同樣的收斂特性）', () => {
    let current = BASE_SIGNATURE
    for (let i = 0; i < 50; i += 1) {
      current = lerpSignatureTowards(current, target, 0.1)
    }
    expect(current.frequency).toBeCloseTo(target.frequency, 1)
    expect(current.waveformShape).toBeCloseTo(target.waveformShape, 1)
  })

  it('保留 current 沒有明確處理的欄位（例如 presetName），用展開帶過去', () => {
    const result = lerpSignatureTowards(BASE_SIGNATURE, target, 0.5)
    expect(result.presetName).toBe(BASE_SIGNATURE.presetName)
  })
})
