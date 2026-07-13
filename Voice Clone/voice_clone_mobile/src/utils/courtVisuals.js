/**
 * courtVisuals.js — 法庭主題視覺用的純函式（顏色、波形取樣、簡易雜訊）
 *
 * 逐字從使用者提供的設計稿 inner-court-survey-fix8.html 內嵌 <script> 搬過來
 * （hsb / flowGrad / waveAt / vnoise / clamp / lerp），數值與行為都沒有更動。
 * 刻意獨立成一個新檔案、不去動既有的 utils/waveformColor.js /
 * utils/waveformPath.js：那兩個檔案是給 pages/ResultPage.jsx（深色宇宙感
 * 紀念畫面，這次改版不動）用的配色系統，跟這裡法庭主題（白紙底、五個
 * OCEAN 色相 hue 值也不同）是兩套獨立的視覺語彙，共用同一份純函式數學
 * 概念相通（都是「正弦波 + 諧波」的合成波），但飽和度/亮度調校的目標不同
 * （白底 vs 深底），硬要合併只會讓兩邊互相牽制、難以各自調整。
 */

export const TAU = Math.PI * 2

export function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v))
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * HSB(HSV) 轉 rgba 字串。
 * @param {number} h 0~360
 * @param {number} s 0~100
 * @param {number} v 0~100
 * @param {number} [a] 0~1
 * @returns {string}
 */
export function hsb(h, s, v, a = 1) {
  s /= 100
  v /= 100
  const c = v * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) {
    r = c
    g = x
  } else if (hp < 2) {
    r = x
    g = c
  } else if (hp < 3) {
    g = c
    b = x
  } else if (hp < 4) {
    g = x
    b = c
  } else if (hp < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const m = v - c
  return `rgba(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)},${a})`
}

/**
 * 依「向度資料 + 標準化 x 座標 + 相位」取一個 -1~1 的波形值（正弦主波 +
 * 2.3 倍頻諧波混合），這是法庭主題所有波形（審訊五色波、口供波形、代理人
 * 波）共用的核心波形函式。
 * @param {{frequency:number, shape:number}} d
 * @param {number} xn 0~1
 * @param {number} ph 相位
 * @param {number} [shapeMul] shape 的縮放倍率
 * @param {number} [freqMul] frequency 的縮放倍率
 */
export function waveAt(d, xn, ph, shapeMul = 1, freqMul = 1) {
  const f = d.frequency * freqMul
  const p = Math.sin(xn * TAU * f + ph)
  const h = Math.sin(xn * TAU * f * 2.3 + ph * 1.7)
  const s = d.shape * shapeMul
  return (1 - s) * p + s * 0.6 * h
}

/**
 * 沿波形橫向流動的漸層色相/亮度（白紙底版：g 高的地方飽和度更深，取代
 * 深底版的「亮帶」，亮度下限拉高避免高飽和+低亮度混出髒黑色）。
 * @returns {[hue:number, brightness:number, g:number]}
 */
export function flowGrad(hue, xn, t, seed, opts = {}) {
  const waves = opts.waves ?? 1.3
  const flowSpeed = opts.flowSpeed ?? 1.4
  const hueShift = opts.hueShift ?? 26
  const g = 0.5 + 0.5 * Math.sin(xn * TAU * waves - t * flowSpeed + seed * 2.1)
  return [(hue + (g - 0.5) * hueShift + 360) % 360, lerp(78, 58, g), g]
}

/**
 * 簡易一維 value noise（用固定隨機種子表 + 平滑插值），用來讓波形帶一點
 * 不規則的「霧感」（審訊畫面裡，某個向度還沒作答夠多題時，波形會比較模糊）。
 */
const NOISE_SEED = Array.from({ length: 512 }, () => Math.random())
export function vnoise(x) {
  const i = Math.floor(x) & 511
  const f = x - Math.floor(x)
  const u = f * f * (3 - 2 * f)
  return NOISE_SEED[i] * (1 - u) + NOISE_SEED[(i + 1) & 511] * u
}

/** canvas 依 CSS 顯示尺寸調整實際畫布解析度，回傳 2d context。 */
export function fitCanvas(cv) {
  if (!cv) return null
  const r = cv.getBoundingClientRect()
  cv.width = r.width
  cv.height = r.height
  return cv.getContext('2d')
}
