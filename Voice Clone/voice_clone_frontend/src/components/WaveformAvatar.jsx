/**
 * WaveformAvatar.jsx — Agent 頭像：以「波形人格」為主軸的沉浸式滿版波場
 *
 * 需求：agent 頭像改用動態波形呈現，初始波形依 agent 背景設定決定（見
 * utils/waveformSignature.js），對話過程中以這個波形為主軸，因為 agent
 * 當下說話的情緒略為動態調整波形形狀（見 utils/emotionSignal.js），整體
 * 呈現要有沉浸感——波紋鋪滿整個 agent 方框的背景，不只是限縮在一個小圓形
 * 頭像裡。除了形狀，顏色（飽和度/明亮度）也是情緒的變量（見
 * utils/waveformColor.js）。
 *
 * ── 版面：滿版而不是圓形頭像 ──────────────────────────────────────────
 * SVG 用固定的邏輯座標系（VIEW_WIDTH × VIEW_HEIGHT）搭配
 * `width="100%" height="100%"` + `preserveAspectRatio="none"`，讓它直接
 * 撐滿外層容器（AgentStage.jsx 裡的 agent 方框），不需要量測容器實際像素
 * 大小（不用 ResizeObserver），容器多大就撐多大。裁切成圓角矩形跟外層
 * 容器一致完全交給外層容器的 `overflow: hidden` + `border-radius` 處理，
 * 這裡不需要自己再做一層 clipPath。
 *
 * ── 多層波場 ──────────────────────────────────────────────────────────
 * 不是畫一條線，而是疊 BAND_COUNT 層波形（見 BANDS 常數），每層用不同的
 * 垂直位移、振幅倍率、相位偏移、透明度（見 utils/waveformPath.js 新增的
 * verticalOffset / ampScale 參數），中間幾層振幅最大、最不透明，邊緣層
 * 較弱較淡，疊出一片會流動的波紋場，搭配一層套用高斯模糊的發光層（沿用
 * 中間那層的資料，加粗加模糊）與底色漸層，營造沉浸式的氛圍背景。
 *
 * ── 動畫迴圈 ──────────────────────────────────────────────────────────
 * 跟第一版一樣，用 requestAnimationFrame 迴圈直接對每個 <path> 的 DOM
 * node 呼叫 setAttribute('d', ...)，不透過 React state 每一幀觸發
 * re-render（同時有好幾個 agent、每秒要更新好幾十次，用 state 驅動會有
 * 不必要的 reconciliation 開銷）。真正的波形數學都在 utils/waveformPath.js
 * 的純函式裡。
 *
 * ── 情緒驅動的波形變化（形狀 + 顏色）────────────────────────────────────
 * currentText（這位 agent 最新一句話的文字，由 AgentStage.jsx 從
 * transcript 算出）透過 utils/emotionSignal.js 的 analyzeTurnEmotion()
 * 換算成情緒偏移，疊加在 persona 基準簽章上（utils/waveformSignature.js
 * 的 applyEmotionSignal()）得到「這一刻應該長怎樣」的目標簽章（同時包含
 * 波形五個參數跟 colorIntensity）。實際套用到波形數學/顏色的並不是這個
 * 目標值本身，而是用 lerpSignatureTowards() 每一幀平滑地往目標值移動的
 * 「有效簽章」（effectiveSignatureRef）——這樣句子一換、情緒偏移跳動時，
 * 波形跟顏色都是漸變過去，不會瞬間變形/變色。isSpeaking 一樣是離散布林值，
 * 用 lerpTowards() 平滑成 speakIntensity 中間值。
 *
 * 顏色（hue + colorIntensity）過去是在 render 時從靜態的 signature prop
 * 算一次，跟動畫迴圈的 effectiveSignature 完全脫鉤（情緒對顏色的偏移算了
 * 但畫面上看不出來）。現在改成顏色也是每一幀從 effectiveSignature 用
 * utils/waveformColor.js 算出來、透過 setAttribute 寫進 DOM，跟波形路徑
 * 用同一個動畫迴圈更新，才能真的反映情緒變化。連帶地，SVG 內部
 * `<linearGradient>` / `<filter>` 的 id 不能再用 hue 組字串（hue 現在會
 * 動態變化，用它當 id 等於每次變化都要新建 DOM 元素），改用掛載時產生一次
 * 的穩定亂數 id。
 */

import { useEffect, useRef } from 'react'
import { buildWavePath, lerpTowards } from '../utils/waveformPath'
import { applyEmotionSignal, lerpSignatureTowards } from '../utils/waveformSignature'
import { analyzeTurnEmotion } from '../utils/emotionSignal'
import { buildWaveformColors } from '../utils/waveformColor'

const SPEAK_INTENSITY_LERP_RATE = 0.08
// 情緒/句子變化時，波形往新目標移動的速度比 speakIntensity 稍慢一點，
// 讓形狀與顏色的轉變感覺是「醞釀」出來的，而不是跟著說話開關一樣立刻反應。
const SIGNATURE_LERP_RATE = 0.035

const VIEW_WIDTH = 240
const VIEW_HEIGHT = 140

// 多層波場的每一層設定：t 從 0 到 1 掃過所有層，中間層（t=0.5）振幅最大、
// 最不透明，邊緣層較弱較淡，疊出有層次感的波紋場而不是死板的單一線條。
const BAND_COUNT = 5
const BANDS = Array.from({ length: BAND_COUNT }, (_, i) => {
  const t = i / (BAND_COUNT - 1) // 0..1
  const distanceFromCenter = Math.abs(t - 0.5) * 2 // 0（中間）..1（邊緣）
  return {
    verticalOffsetFactor: (t - 0.5) * 0.66, // -0.33..0.33
    ampScale: 1 - distanceFromCenter * 0.6,
    phaseOffset: i * 0.55,
    opacity: 0.16 + (1 - distanceFromCenter) * 0.42,
    lightnessOffset: i % 2 === 0 ? 4 : -4,
    isGlowSource: i === Math.floor((BAND_COUNT - 1) / 2),
  }
})

let instanceCounter = 0

export default function WaveformAvatar({ signature, isSpeaking, currentText }) {
  const bandPathRefs = useRef([])
  const glowPathRef = useRef(null)
  const bgStop0Ref = useRef(null)
  const bgStop1Ref = useRef(null)
  const speakIntensityRef = useRef(0)
  const effectiveSignatureRef = useRef(signature)
  const targetSignatureRef = useRef(signature)
  const startTimeRef = useRef(null)
  const rafIdRef = useRef(null)
  const isSpeakingRef = useRef(isSpeaking)

  // 穩定的 per-instance id，跟 hue 脫鉤（hue 現在會隨情緒動態變化，不能再
  // 拿來組 SVG id，否則等於每次變化都要建立新的 <linearGradient>/<filter>）。
  // 只在第一次 render 時產生一次，往後每次 render 都沿用同一個值。
  const instanceIdRef = useRef(null)
  if (instanceIdRef.current === null) {
    instanceCounter += 1
    instanceIdRef.current = `wf-${instanceCounter}`
  }
  const gradientId = `${instanceIdRef.current}-bg`
  const glowFilterId = `${instanceIdRef.current}-glow`

  // 用 ref 保存最新的 isSpeaking，避免動畫迴圈的 useEffect 因為
  // isSpeaking 變化而整個重新掛載（重掛會讓 startTimeRef 重置、波形跳一下）。
  useEffect(() => {
    isSpeakingRef.current = isSpeaking
  }, [isSpeaking])

  // 換了 agent（signature 本身變了）時，直接重置有效簽章，不需要漸變；
  // 只有「同一個 agent、句子內容變化」才應該漸變（見下面 targetSignatureRef
  // 的更新邏輯與動畫迴圈裡的 lerpSignatureTowards）。
  useEffect(() => {
    effectiveSignatureRef.current = signature
    targetSignatureRef.current = applyEmotionSignal(signature, analyzeTurnEmotion(currentText))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // 句子內容變化時（同一個 agent 講到下一句），重新算目標簽章，但不重置
  // effectiveSignatureRef——讓動畫迴圈的 lerp 自然地從目前形狀/顏色過渡過去。
  useEffect(() => {
    targetSignatureRef.current = applyEmotionSignal(signature, analyzeTurnEmotion(currentText))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentText])

  useEffect(() => {
    const animate = (timestamp) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp
      const time = (timestamp - startTimeRef.current) / 1000

      const speakTarget = isSpeakingRef.current ? 1 : 0
      speakIntensityRef.current = lerpTowards(speakIntensityRef.current, speakTarget, SPEAK_INTENSITY_LERP_RATE)
      const speakIntensity = speakIntensityRef.current

      effectiveSignatureRef.current = lerpSignatureTowards(
        effectiveSignatureRef.current,
        targetSignatureRef.current,
        SIGNATURE_LERP_RATE,
      )
      const effectiveSignature = effectiveSignatureRef.current

      // 顏色（hue + colorIntensity）每一幀都跟波形一起從 effectiveSignature
      // 重新算，才會真的反映情緒對顏色的偏移，而不是只在 mount 時算一次。
      const colors = buildWaveformColors({
        hue: effectiveSignature.hue,
        colorIntensity: effectiveSignature.colorIntensity,
      })
      if (bgStop0Ref.current) bgStop0Ref.current.setAttribute('stop-color', colors.bgStop0)
      if (bgStop1Ref.current) bgStop1Ref.current.setAttribute('stop-color', colors.bgStop1)
      if (glowPathRef.current) glowPathRef.current.setAttribute('stroke', colors.glow)

      BANDS.forEach((band, i) => {
        const d = buildWavePath({
          signature: effectiveSignature,
          time,
          speakIntensity,
          width: VIEW_WIDTH,
          height: VIEW_HEIGHT,
          phaseOffset: band.phaseOffset,
          verticalOffset: band.verticalOffsetFactor * VIEW_HEIGHT,
          ampScale: band.ampScale,
        })
        const el = bandPathRefs.current[i]
        if (el) {
          el.setAttribute('d', d)
          el.setAttribute('stroke', colors.bandColor(band.lightnessOffset))
        }
        if (band.isGlowSource && glowPathRef.current) {
          glowPathRef.current.setAttribute('d', d)
        }
      })

      rafIdRef.current = requestAnimationFrame(animate)
    }

    rafIdRef.current = requestAnimationFrame(animate)
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
      startTimeRef.current = null
    }
    // isSpeaking/currentText 刻意不放進依賴（見上方 ref 說明），避免動畫
    // 迴圈因此重新掛載中斷連續性；只有 signature 本身變化（agent 不同）
    // 才需要重新開始迴圈。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop ref={bgStop0Ref} offset="0%" />
          <stop ref={bgStop1Ref} offset="100%" />
        </linearGradient>
        <filter id={glowFilterId} x="-40%" y="-60%" width="180%" height="220%">
          <feGaussianBlur stdDeviation="4.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect x="0" y="0" width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${gradientId})`} />

      <path
        ref={glowPathRef}
        fill="none"
        strokeWidth={isSpeaking ? 6 : 3.5}
        strokeLinecap="round"
        opacity={0.4}
        filter={`url(#${glowFilterId})`}
      />

      {BANDS.map((band, i) => (
        <path
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          ref={(el) => {
            bandPathRefs.current[i] = el
          }}
          fill="none"
          strokeWidth={isSpeaking ? 2.2 : 1.5}
          strokeLinecap="round"
          opacity={band.opacity}
        />
      ))}
    </svg>
  )
}
