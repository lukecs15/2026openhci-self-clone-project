/**
 * waveformPath.test.js — 驗證波形數學（buildWavePath / lerpTowards）
 */

import { describe, it, expect } from 'vitest'
import { buildWavePath, lerpTowards } from '../utils/waveformPath'

const BASE_SIGNATURE = {
  frequency: 1.2,
  amplitude: 0.3,
  waveHeight: 0.8,
  waveformShape: 0.4,
}

function parsePathYs(d) {
  // "M x y L x y L x y ..." → 取出所有 y 座標
  const numbers = d
    .replace(/[ML]/g, '')
    .trim()
    .split(/\s+/)
    .map(Number)
  const ys = []
  for (let i = 1; i < numbers.length; i += 2) ys.push(numbers[i])
  return ys
}

describe('buildWavePath', () => {
  it('回傳的是以 M 開頭、用 L 連接取樣點的 SVG path 字串', () => {
    const d = buildWavePath({ signature: BASE_SIGNATURE, time: 0 })
    expect(d.startsWith('M ')).toBe(true)
    expect(d).toContain('L ')
  })

  it('同樣的參數（含 time）每次呼叫都得到完全相同的結果（決定性）', () => {
    const args = { signature: BASE_SIGNATURE, time: 1.234, speakIntensity: 0.5 }
    expect(buildWavePath(args)).toBe(buildWavePath({ ...args }))
  })

  it('不同的 time 通常會產生不同的路徑（波形真的會隨時間變化）', () => {
    const d1 = buildWavePath({ signature: BASE_SIGNATURE, time: 0 })
    const d2 = buildWavePath({ signature: BASE_SIGNATURE, time: 1.5 })
    expect(d1).not.toBe(d2)
  })

  it('points 參數決定取樣點數量（點數 = points + 1）', () => {
    const d = buildWavePath({ signature: BASE_SIGNATURE, time: 0, points: 10 })
    const ys = parsePathYs(d)
    expect(ys).toHaveLength(11)
  })

  it('speakIntensity 越高，波形偏離中心線的振幅越大（說話中更有活力）', () => {
    // 固定 time 在呼吸 envelope 的波峰附近，避免呼吸節奏本身的起伏干擾比較。
    const time = 0.8
    const height = 100
    const quiet = buildWavePath({
      signature: BASE_SIGNATURE,
      time,
      speakIntensity: 0,
      height,
      points: 60,
    })
    const speaking = buildWavePath({
      signature: BASE_SIGNATURE,
      time,
      speakIntensity: 1,
      height,
      points: 60,
    })

    const maxDeviation = (d) => {
      const ys = parsePathYs(d)
      const center = height / 2
      return Math.max(...ys.map((y) => Math.abs(y - center)))
    }

    expect(maxDeviation(speaking)).toBeGreaterThan(maxDeviation(quiet))
  })

  it('waveHeight 越大，波形可用的振幅空間越大（同一時刻偏離幅度也越大）', () => {
    const time = 0.8
    const height = 100
    const lowHeight = buildWavePath({
      signature: { ...BASE_SIGNATURE, waveHeight: 0.4 },
      time,
      height,
      points: 60,
    })
    const highHeight = buildWavePath({
      signature: { ...BASE_SIGNATURE, waveHeight: 1.0 },
      time,
      height,
      points: 60,
    })

    const maxDeviation = (d) => {
      const ys = parsePathYs(d)
      const center = height / 2
      return Math.max(...ys.map((y) => Math.abs(y - center)))
    }

    expect(maxDeviation(highHeight)).toBeGreaterThan(maxDeviation(lowHeight))
  })

  it('phaseOffset 不同時，同一時刻的波形也會不同（讓多層波形彼此錯開）', () => {
    const d1 = buildWavePath({ signature: BASE_SIGNATURE, time: 0.5, phaseOffset: 0 })
    const d2 = buildWavePath({ signature: BASE_SIGNATURE, time: 0.5, phaseOffset: 0.9 })
    expect(d1).not.toBe(d2)
  })

  it('所有取樣點的 y 座標都落在 [0, height] 範圍內，不會超出 SVG 畫布', () => {
    // 刻意用理論上最容易溢出的組合：waveformShape=0（純正弦、沒有 0.6
    // 諧波係數壓低振幅）+ amplitude/waveHeight 都在上限 + 說話中——確保
    // clamp 在最壞情況下仍然有效，不是只在溫和參數下剛好沒超出範圍。
    const height = 80
    const breathePeriodSeconds = 2.6 // 跟 waveformPath.js 的 BREATHE_PERIOD_SECONDS 一致
    // 掃過整個呼吸週期，確保真的測到 envelope 接近峰值的最壞情況。
    for (let t = 0; t < breathePeriodSeconds; t += 0.1) {
      const d = buildWavePath({
        signature: { frequency: 2, amplitude: 0.6, waveHeight: 1.0, waveformShape: 0 },
        time: t,
        speakIntensity: 1,
        height,
        points: 40,
      })
      const ys = parsePathYs(d)
      ys.forEach((y) => {
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(height)
      })
    }
  })
})

describe('buildWavePath — 多層波場參數（verticalOffset / ampScale）', () => {
  it('verticalOffset 會整體平移波形的中心線，但不改變波形本身的起伏形狀', () => {
    const height = 100
    const time = 0.5
    const noOffset = buildWavePath({ signature: BASE_SIGNATURE, time, height, points: 30 })
    const offset = buildWavePath({
      signature: BASE_SIGNATURE,
      time,
      height,
      points: 30,
      verticalOffset: 20,
    })
    const ysNoOffset = parsePathYs(noOffset)
    const ysOffset = parsePathYs(offset)
    // 每個取樣點都應該剛好平移了 20（在 clamp 範圍內的點）。
    ysNoOffset.forEach((y, i) => {
      const expected = Math.min(height, Math.max(0, y + 20))
      expect(ysOffset[i]).toBeCloseTo(expected, 5)
    })
  })

  it('ampScale 越小，這一層偏離中心線的振幅越小（多層波場裡邊緣層較弱）', () => {
    const height = 100
    const time = 0.5
    const fullAmp = buildWavePath({
      signature: BASE_SIGNATURE,
      time,
      height,
      points: 60,
      speakIntensity: 1,
      ampScale: 1,
    })
    const halfAmp = buildWavePath({
      signature: BASE_SIGNATURE,
      time,
      height,
      points: 60,
      speakIntensity: 1,
      ampScale: 0.4,
    })

    const maxDeviation = (d) => {
      const ys = parsePathYs(d)
      const center = height / 2
      return Math.max(...ys.map((y) => Math.abs(y - center)))
    }

    expect(maxDeviation(halfAmp)).toBeLessThan(maxDeviation(fullAmp))
  })

  it('ampScale=0 時波形完全貼平在中心線（加上 verticalOffset 的話貼平在偏移後的中心線）', () => {
    const height = 100
    const d = buildWavePath({
      signature: BASE_SIGNATURE,
      time: 0.5,
      height,
      points: 20,
      speakIntensity: 1,
      ampScale: 0,
      verticalOffset: -15,
    })
    const ys = parsePathYs(d)
    ys.forEach((y) => expect(y).toBeCloseTo(height / 2 - 15, 5))
  })
})

describe('lerpTowards', () => {
  it('rate=0 時完全不移動', () => {
    expect(lerpTowards(0, 1, 0)).toBe(0)
  })

  it('rate=1 時直接跳到目標值', () => {
    expect(lerpTowards(0, 1, 1)).toBe(1)
  })

  it('rate 介於 0~1 時往目標移動一部分，不會超過目標', () => {
    const result = lerpTowards(0, 1, 0.1)
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(1)
  })

  it('反覆呼叫會讓值持續逼近目標', () => {
    let value = 0
    for (let i = 0; i < 50; i += 1) {
      value = lerpTowards(value, 1, 0.1)
    }
    expect(value).toBeGreaterThan(0.99)
  })

  it('超出 0~1 範圍的 rate 會被夾住', () => {
    expect(lerpTowards(0, 10, 5)).toBe(10) // rate 夾到 1
    expect(lerpTowards(5, 10, -1)).toBe(5) // rate 夾到 0
  })
})
