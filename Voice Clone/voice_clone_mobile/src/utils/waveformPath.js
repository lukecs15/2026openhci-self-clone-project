/**
 * waveformPath.js — 把「波形簽章」+ 時間 + 說話強度換算成一條 SVG path
 *
 * 直接從 voice_clone_frontend/src/utils/waveformPath.js 移植過來（純函式，
 * 兩邊行為必須完全一致）。手機端只在結束紀念畫面用 isSpeaking=true 呈現
 * 融合波形（一直保持「有活力」的狀態），但完整移植整份檔案方便對照維護。
 */

const TWO_PI = Math.PI * 2
const BREATHE_PERIOD_SECONDS = 2.6

/**
 * @param {object} params
 * @param {{frequency:number, amplitude:number, waveHeight:number, waveformShape:number}} params.signature
 * @param {number} params.time 已經過的秒數
 * @param {number} [params.speakIntensity] 0～1
 * @param {number} [params.width]
 * @param {number} [params.height]
 * @param {number} [params.points]
 * @param {number} [params.phaseOffset]
 * @param {number} [params.verticalOffset]
 * @param {number} [params.ampScale]
 * @returns {string}
 */
export function buildWavePath({
  signature,
  time,
  speakIntensity = 0,
  width = 120,
  height = 120,
  points = 40,
  phaseOffset = 0,
  verticalOffset = 0,
  ampScale = 1,
}) {
  const { frequency, amplitude, waveHeight, waveformShape } = signature
  const clampedIntensity = Math.min(1, Math.max(0, speakIntensity))

  const breathe = 0.85 + 0.15 * Math.sin((time / BREATHE_PERIOD_SECONDS) * TWO_PI)
  const speakAmpBoost = 1 + clampedIntensity * 0.8
  const phaseSpeed = 0.9 + clampedIntensity * 1.3

  const centerY = height / 2 + verticalOffset
  const usableHalfHeight = (height / 2) * waveHeight
  const amp = amplitude * usableHalfHeight * breathe * speakAmpBoost * ampScale
  const phase = time * phaseSpeed + phaseOffset

  const coords = []
  for (let i = 0; i <= points; i += 1) {
    const xNorm = i / points
    const x = xNorm * width
    const primary = Math.sin(xNorm * TWO_PI * frequency + phase)
    const harmonic = Math.sin(xNorm * TWO_PI * frequency * 2.3 + phase * 1.7)
    const wave = (1 - waveformShape) * primary + waveformShape * 0.6 * harmonic
    const y = Math.min(height, Math.max(0, centerY + wave * amp))
    coords.push([x, y])
  }

  let d = `M ${coords[0][0].toFixed(2)} ${coords[0][1].toFixed(2)}`
  for (let i = 1; i < coords.length; i += 1) {
    d += ` L ${coords[i][0].toFixed(2)} ${coords[i][1].toFixed(2)}`
  }
  return d
}

/**
 * @param {number} current
 * @param {number} target
 * @param {number} rate 0～1
 * @returns {number}
 */
export function lerpTowards(current, target, rate) {
  const clampedRate = Math.min(1, Math.max(0, rate))
  return current + (target - current) * clampedRate
}
