/**
 * waveformColor.test.js — 驗證顏色（hue + colorIntensity）換算成 hsl() 字串
 */

import { describe, it, expect } from 'vitest'
import { buildWaveformColors } from '../utils/waveformColor'

function parseHsl(str) {
  const match = str.match(/^hsl\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?)%, (\d+(?:\.\d+)?)%\)$/)
  expect(match).not.toBeNull()
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) }
}

describe('buildWaveformColors', () => {
  it('回傳的四個顏色都是合法的 hsl() 字串', () => {
    const colors = buildWaveformColors({ hue: 200, colorIntensity: 0.5 })
    expect(() => parseHsl(colors.bgStop0)).not.toThrow()
    expect(() => parseHsl(colors.bgStop1)).not.toThrow()
    expect(() => parseHsl(colors.glow)).not.toThrow()
    expect(() => parseHsl(colors.bandColor())).not.toThrow()
  })

  it('同樣的參數每次呼叫都得到完全相同的結果（決定性）', () => {
    const a = buildWaveformColors({ hue: 120, colorIntensity: 0.7 })
    const b = buildWaveformColors({ hue: 120, colorIntensity: 0.7 })
    expect(a.bgStop0).toBe(b.bgStop0)
    expect(a.glow).toBe(b.glow)
  })

  it('colorIntensity 越高，glow 跟 band 顏色的飽和度/明亮度都越高（更鮮明）', () => {
    const dim = buildWaveformColors({ hue: 200, colorIntensity: 0 })
    const vivid = buildWaveformColors({ hue: 200, colorIntensity: 1 })
    const dimGlow = parseHsl(dim.glow)
    const vividGlow = parseHsl(vivid.glow)
    expect(vividGlow.s).toBeGreaterThan(dimGlow.s)
    expect(vividGlow.l).toBeGreaterThan(dimGlow.l)

    const dimBand = parseHsl(dim.bandColor())
    const vividBand = parseHsl(vivid.bandColor())
    expect(vividBand.s).toBeGreaterThan(dimBand.s)
    expect(vividBand.l).toBeGreaterThan(dimBand.l)
  })

  it('colorIntensity 超出 [0,1] 範圍時會被夾住，不會產生負數或超過 100 的飽和度/明亮度', () => {
    const tooHigh = buildWaveformColors({ hue: 200, colorIntensity: 5 })
    const tooLow = buildWaveformColors({ hue: 200, colorIntensity: -5 })
    const expected = buildWaveformColors({ hue: 200, colorIntensity: 1 })
    const expectedLow = buildWaveformColors({ hue: 200, colorIntensity: 0 })
    expect(tooHigh.glow).toBe(expected.glow)
    expect(tooLow.glow).toBe(expectedLow.glow)
  })

  it('沒有指定 colorIntensity 時使用預設中間值', () => {
    const colors = buildWaveformColors({ hue: 200 })
    const { s, l } = parseHsl(colors.glow)
    expect(s).toBeGreaterThan(0)
    expect(l).toBeGreaterThan(0)
  })

  it('bgStop1 的色相是 hue+40（跨過 360 時會 wrap），跟 bgStop0 用同一個基準 hue 不同色相', () => {
    const colors = buildWaveformColors({ hue: 340, colorIntensity: 0.5 })
    const stop0 = parseHsl(colors.bgStop0)
    const stop1 = parseHsl(colors.bgStop1)
    expect(stop0.h).toBe(340)
    expect(stop1.h).toBe(20) // (340 + 40) % 360
  })

  it('bandColor(offset) 的 offset 會直接加到明亮度上，用來讓多層波場奇偶層明暗交錯', () => {
    const colors = buildWaveformColors({ hue: 200, colorIntensity: 0.5 })
    const base = parseHsl(colors.bandColor())
    const brighter = parseHsl(colors.bandColor(4))
    const darker = parseHsl(colors.bandColor(-4))
    expect(brighter.l).toBeCloseTo(base.l + 4, 5)
    expect(darker.l).toBeCloseTo(base.l - 4, 5)
    // 色相跟飽和度不受 offset 影響，只有明亮度變化。
    expect(brighter.h).toBe(base.h)
    expect(brighter.s).toBe(base.s)
  })
})
