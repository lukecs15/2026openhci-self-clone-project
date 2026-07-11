/**
 * waveformColor.js — 把「色相 + 情緒驅動的飽和度/明亮度」換算成實際顏色
 *
 * 直接從 voice_clone_frontend/src/utils/waveformColor.js 移植過來（純函式，
 * 兩邊行為必須完全一致）。
 */

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

function lerpRange(t, [min, max]) {
  return min + (max - min) * t
}

/**
 * @param {object} params
 * @param {number} params.hue 0～359
 * @param {number} [params.colorIntensity] 0～1
 * @returns {{ bgStop0: string, bgStop1: string, glow: string, bandColor: (offset?: number) => string }}
 */
export function buildWaveformColors({ hue, colorIntensity = 0.55 }) {
  const t = clamp01(colorIntensity)
  const bgHue = hue
  const bgStop1Hue = (hue + 40) % 360

  const bgStop0Saturation = lerpRange(t, [35, 70])
  const bgStop0Lightness = lerpRange(t, [8, 22])
  const bgStop1Saturation = lerpRange(t, [25, 55])
  const bgStop1Lightness = lerpRange(t, [4, 12])
  const glowSaturation = lerpRange(t, [55, 95])
  const glowLightness = lerpRange(t, [45, 68])
  const bandSaturation = lerpRange(t, [45, 85])
  const bandLightness = lerpRange(t, [45, 68])

  return {
    bgStop0: `hsl(${bgHue}, ${bgStop0Saturation.toFixed(1)}%, ${bgStop0Lightness.toFixed(1)}%)`,
    bgStop1: `hsl(${bgStop1Hue}, ${bgStop1Saturation.toFixed(1)}%, ${bgStop1Lightness.toFixed(1)}%)`,
    glow: `hsl(${hue}, ${glowSaturation.toFixed(1)}%, ${glowLightness.toFixed(1)}%)`,
    bandColor: (offset = 0) => `hsl(${hue}, ${bandSaturation.toFixed(1)}%, ${(bandLightness + offset).toFixed(1)}%)`,
  }
}
