/**
 * waveformSignature.test.js — 驗證 agent 波形人格簽章的決定性與範圍
 */

import { describe, it, expect } from 'vitest'
import {
  getWaveformSignature,
  WAVEFORM_PRESETS,
  applyEmotionSignal,
  lerpSignatureTowards,
  mergeWaveformSignatures,
} from '../utils/waveformSignature'

const FIELD_BOUNDS = {
  frequency: [0.4, 3.0],
  amplitude: [0.1, 0.6],
  waveHeight: [0.4, 1.0],
  waveformShape: [0, 1],
  colorIntensity: [0.2, 1],
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
  colorIntensity: 0.55,
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

  it('把 intensityDelta 疊加到 colorIntensity 上（顏色也是情緒的變量）', () => {
    const result = applyEmotionSignal(BASE_SIGNATURE, { intensityDelta: 0.2 })
    expect(result.colorIntensity).toBeCloseTo(0.75, 5)
  })

  it('colorIntensity 疊加後一樣會 clamp 在 [0.2, 1] 範圍內', () => {
    const veryIntense = applyEmotionSignal(BASE_SIGNATURE, { intensityDelta: 100 })
    expect(veryIntense.colorIntensity).toBeLessThanOrEqual(1)

    const veryFlat = applyEmotionSignal(BASE_SIGNATURE, { intensityDelta: -100 })
    expect(veryFlat.colorIntensity).toBeGreaterThanOrEqual(0.2)
  })

  it('baseSignature 沒有 colorIntensity 欄位時（例如舊資料），用預設基準值當防呆', () => {
    const legacySignature = { frequency: 1.0, amplitude: 0.3, waveHeight: 0.8, waveformShape: 0.3, hue: 200 }
    const result = applyEmotionSignal(legacySignature, { intensityDelta: 0.1 })
    expect(result.colorIntensity).toBeCloseTo(0.65, 5) // 0.55（預設基準）+ 0.1
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
    colorIntensity: 1.0,
  }

  it('rate=0 時完全不移動（回傳值等於 current 的各欄位）', () => {
    const result = lerpSignatureTowards(BASE_SIGNATURE, target, 0)
    expect(result.frequency).toBe(BASE_SIGNATURE.frequency)
    expect(result.amplitude).toBe(BASE_SIGNATURE.amplitude)
    expect(result.waveHeight).toBe(BASE_SIGNATURE.waveHeight)
    expect(result.waveformShape).toBe(BASE_SIGNATURE.waveformShape)
    expect(result.hue).toBe(BASE_SIGNATURE.hue)
    expect(result.colorIntensity).toBe(BASE_SIGNATURE.colorIntensity)
  })

  it('rate=1 時直接跳到 target 的各欄位', () => {
    const result = lerpSignatureTowards(BASE_SIGNATURE, target, 1)
    expect(result.frequency).toBe(target.frequency)
    expect(result.amplitude).toBe(target.amplitude)
    expect(result.waveHeight).toBe(target.waveHeight)
    expect(result.waveformShape).toBe(target.waveformShape)
    expect(result.hue).toBe(target.hue)
    expect(result.colorIntensity).toBe(target.colorIntensity)
  })

  it('colorIntensity 缺欄位時（current 或 target 任一沒有），用預設基準值當防呆，不會變成 NaN', () => {
    const currentWithoutColor = { ...BASE_SIGNATURE }
    delete currentWithoutColor.colorIntensity
    const result = lerpSignatureTowards(currentWithoutColor, target, 0.5)
    expect(Number.isNaN(result.colorIntensity)).toBe(false)
    expect(result.colorIntensity).toBeCloseTo((0.55 + 1.0) / 2, 5)
  })

  it('rate 介於 0~1 時每個欄位都各自往 target 移動一部分，不超過 target', () => {
    const result = lerpSignatureTowards(BASE_SIGNATURE, target, 0.25)
    expect(result.frequency).toBeGreaterThan(BASE_SIGNATURE.frequency)
    expect(result.frequency).toBeLessThan(target.frequency)
    expect(result.waveHeight).toBeGreaterThan(BASE_SIGNATURE.waveHeight)
    expect(result.waveHeight).toBeLessThan(target.waveHeight)
    expect(result.colorIntensity).toBeGreaterThan(BASE_SIGNATURE.colorIntensity)
    expect(result.colorIntensity).toBeLessThan(target.colorIntensity)
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

describe('mergeWaveformSignatures', () => {
  it('linear 欄位（frequency/amplitude/waveHeight/waveformShape/colorIntensity）用算術平均', () => {
    const a = { frequency: 1.0, amplitude: 0.2, waveHeight: 0.6, waveformShape: 0.2, hue: 0, colorIntensity: 0.4 }
    const b = { frequency: 2.0, amplitude: 0.4, waveHeight: 1.0, waveformShape: 0.6, hue: 0, colorIntensity: 0.8 }
    const merged = mergeWaveformSignatures([a, b])

    expect(merged.frequency).toBeCloseTo(1.5, 5)
    expect(merged.amplitude).toBeCloseTo(0.3, 5)
    expect(merged.waveHeight).toBeCloseTo(0.8, 5)
    expect(merged.waveformShape).toBeCloseTo(0.4, 5)
    expect(merged.colorIntensity).toBeCloseTo(0.6, 5)
  })

  it('hue 用圓形平均，不是直線平均（例如 90 度與 270 度的直線平均是 180 度，但兩者方向相反，圓形平均應該落在 0 或 180 附近其中一個穩定值）', () => {
    const a = { frequency: 1, amplitude: 0.2, waveHeight: 0.6, waveformShape: 0.2, hue: 10, colorIntensity: 0.5 }
    const b = { frequency: 1, amplitude: 0.2, waveHeight: 0.6, waveformShape: 0.2, hue: 350, colorIntensity: 0.5 }
    const merged = mergeWaveformSignatures([a, b])

    // 10 度與 350 度（等同 -10 度）的正確圓形平均是 0 度，不是直線平均的 180 度
    expect(merged.hue).toBe(0)
  })

  it('三個 hue 值的圓形平均驗證：0、120、240 度應該平均成一個穩定值（不是直線平均的 120）', () => {
    const signatures = [0, 120, 240].map((hue) => ({
      frequency: 1,
      amplitude: 0.2,
      waveHeight: 0.6,
      waveformShape: 0.2,
      hue,
      colorIntensity: 0.5,
    }))
    const merged = mergeWaveformSignatures(signatures)
    // 三個角度完全均勻分布在圓上，向量和接近 0，atan2(0,0) = 0，是合理的穩定結果
    expect(merged.hue).toBeGreaterThanOrEqual(0)
    expect(merged.hue).toBeLessThan(360)
  })

  it('回傳值的每個欄位都落在合理範圍內（clamp 過）', () => {
    const signatures = ['agent-a', 'agent-b', 'agent-c'].map((id) => getWaveformSignature({ agent_id: id }))
    const merged = mergeWaveformSignatures(signatures)
    expectWithinBounds(merged)
  })

  it('只有一個簽章時，合併結果應該等於（在誤差範圍內）原本的簽章', () => {
    const only = getWaveformSignature({ agent_id: 'agent-solo' })
    const merged = mergeWaveformSignatures([only])
    expect(merged.frequency).toBeCloseTo(only.frequency, 5)
    expect(merged.amplitude).toBeCloseTo(only.amplitude, 5)
    expect(merged.waveHeight).toBeCloseTo(only.waveHeight, 5)
    expect(merged.waveformShape).toBeCloseTo(only.waveformShape, 5)
    expect(merged.hue).toBe(only.hue)
    expect(merged.colorIntensity).toBeCloseTo(only.colorIntensity, 5)
  })

  it('空陣列或 null 時回傳一組落在合理範圍內的保底簽章，不會拋例外', () => {
    expect(() => mergeWaveformSignatures([])).not.toThrow()
    expect(() => mergeWaveformSignatures(null)).not.toThrow()
    expectWithinBounds(mergeWaveformSignatures([]))
    expectWithinBounds(mergeWaveformSignatures(null))
  })

  it('缺少 colorIntensity 欄位的簽章（例如舊資料）用預設基準值防呆，不會變成 NaN', () => {
    const legacy = { frequency: 1, amplitude: 0.2, waveHeight: 0.6, waveformShape: 0.2, hue: 100 }
    const withColor = { frequency: 1, amplitude: 0.2, waveHeight: 0.6, waveformShape: 0.2, hue: 100, colorIntensity: 0.9 }
    const merged = mergeWaveformSignatures([legacy, withColor])
    expect(Number.isNaN(merged.colorIntensity)).toBe(false)
    expect(merged.colorIntensity).toBeCloseTo((0.55 + 0.9) / 2, 5)
  })
})
