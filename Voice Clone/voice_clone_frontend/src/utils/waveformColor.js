/**
 * waveformColor.js — 把「色相 + 情緒驅動的飽和度/明亮度」換算成實際顏色
 *
 * 需求：除了波形形狀，顏色（飽和度/明亮度，這裡統稱 colorIntensity）也應該
 * 是情緒的變量——情緒越激動（興奮或緊張）顏色應該越飽和明亮，猶豫/平靜時
 * 顏色應該越黯淡柔和。跟 hue（色相，代表角色一直以來的特質）是兩個分開的
 * 維度，這個檔案負責把兩者一起換算成 WaveformAvatar.jsx 實際會用到的幾組
 * `hsl()` 顏色字串。
 *
 * 抽成跟 React/DOM 無關的純函式（跟 waveformPath.js 同樣的理由），方便直接
 * 用 vitest 驗證「colorIntensity 越高顏色越飽和/明亮」這件事本身，不需要
 * 真的 render SVG。
 *
 * 每一組顏色都用 colorIntensity（0～1）在一個「黯淡」跟「鮮明」的飽和度/
 * 明亮度區間之間線性插值：
 *   - 背景漸層（bgStop0 / bgStop1）：整體偏暗，維持背景的沉靜感，不會因為
 *     情緒激動就變成刺眼的背景。
 *   - 發光層（glow）：本來就是最亮最飽和的一層，colorIntensity 影響幅度
 *     也最大，情緒激動時「發光」的效果最有感。
 *   - 波形線條（band）：中等飽和度/明亮度，`bandColor(offset)` 接受一個
 *     額外的明亮度偏移量，用來讓多層波場（見 WaveformAvatar.jsx 的
 *     BANDS）奇偶層有一點明暗交錯，維持層次感。
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
 * @param {number} [params.colorIntensity] 0～1，情緒驅動的飽和度/明亮度強度
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
