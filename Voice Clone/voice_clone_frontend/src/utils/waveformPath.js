/**
 * waveformPath.js — 把「波形簽章」+ 時間 + 說話強度換算成一條 SVG path
 *
 * 抽成跟 React/DOM 無關的純函式（跟 waveformSignature.js 同樣的理由），
 * 方便直接用 vitest 驗證數學邏輯本身，不需要真的 render 元件、跑
 * requestAnimationFrame。實際的動畫迴圈（每一幀呼叫這個函式、把結果寫進
 * <path d="...">）放在 components/WaveformAvatar.jsx。
 *
 * 需求對照（沉浸感、以 persona 波形為主軸、對話過程略為動態調整）：
 *   - 「主軸」＝ waveformSignature 的五個參數決定的基準波形，任何時刻的
 *     波形都是這個基準波形的變形，不會因為說話與否整個換一種長相。
 *   - 「呼吸」envelope：即使沒人說話，波形也會用一個很慢（約 3.2 秒一個
 *     週期）的正弦波緩慢起伏，讓頭像感覺「活著」而不是靜態圖案。
 *   - 「說話中」：speakIntensity（0～1，由呼叫端平滑過渡，見
 *     WaveformAvatar.jsx）同時放大振幅、加快相位前進速度，讓波形在說話
 *     時明顯更有活力，安靜下來後平滑退回基準狀態。
 *   - waveformShape 控制的是「主波形」跟「高頻諧波」的混合比例：0 接近
 *     單純正弦波（平滑、規律），1 疊加更多高頻諧波（起伏更複雜、更不規則），
 *     對應「說話方式、人格風格」的差異。
 *   - verticalOffset / ampScale：用來把同一組簽章疊出「多層波場」（見
 *     WaveformAvatar.jsx 的沉浸式滿版背景設計），每一層用不同的垂直位移
 *     跟振幅倍率、加上不同的 phaseOffset，疊在一起形成一片會流動的波紋，
 *     而不是單獨一條線。
 */

const TWO_PI = Math.PI * 2
// 呼吸週期（秒）：不說話時波形仍會緩慢起伏的節奏。稍微調快一點（原本
// 3.2 秒），讓待機時的流動感也更有生氣，呼應「波紋流動速度整體再快一點」
// 的需求。
const BREATHE_PERIOD_SECONDS = 2.6

/**
 * @param {object} params
 * @param {{frequency:number, amplitude:number, waveHeight:number, waveformShape:number}} params.signature
 * @param {number} params.time 已經過的秒數（通常由 requestAnimationFrame 累積）
 * @param {number} [params.speakIntensity] 0（安靜）～1（說話中），可以是過渡中的中間值
 * @param {number} [params.width] SVG 寬度
 * @param {number} [params.height] SVG 高度
 * @param {number} [params.points] 取樣點數，越多線條越平滑，但運算量也越大
 * @param {number} [params.phaseOffset] 額外的相位偏移，用來讓多層波形彼此錯開
 * @param {number} [params.verticalOffset] 中心線的垂直偏移量（像素），用來把多層波形堆疊在畫布不同高度
 * @param {number} [params.ampScale] 這一層相對於基準振幅的倍率（多層波場時每層可以有不同強度）
 * @returns {string} SVG <path> 的 d 屬性字串（用 L 直線連接取樣點，點數夠多時視覺上仍然平滑）
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

  // 呼吸 envelope：0.85～1.0 之間緩慢起伏，不說話時波形也不會死板。
  const breathe = 0.85 + 0.15 * Math.sin((time / BREATHE_PERIOD_SECONDS) * TWO_PI)
  // 說話中振幅放大到最多 1.8 倍。
  const speakAmpBoost = 1 + clampedIntensity * 0.8
  // 說話中相位前進速度加快（波形「動得比較快」），安靜時仍保有基礎流動感。
  // 基準值比第一版提高約 50%（原本 0.6 + intensity*0.9），呼應「波紋流動
  // 速度整體再快一點」的需求。
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
    // 夾在 [0, height] 內：極端訊號組合（例如之後問卷流程給出的 amplitude/
    // waveHeight 剛好都貼近上限、又同時在說話）理論上可能讓波形稍微超出
    // SVG 畫布，clamp 保證取樣點一定落在畫布範圍內，不會被裁掉或溢出。
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
 * 平滑地把目前值往目標值移動一小步（frame-rate 無關的線性插值）。
 * 用來讓 speakIntensity 在 isSpeaking 切換時平滑過渡，而不是瞬間跳變。
 *
 * @param {number} current
 * @param {number} target
 * @param {number} rate 0～1，每次呼叫要往目標移動的比例（不是絕對速度）
 * @returns {number}
 */
export function lerpTowards(current, target, rate) {
  const clampedRate = Math.min(1, Math.max(0, rate))
  return current + (target - current) * clampedRate
}
