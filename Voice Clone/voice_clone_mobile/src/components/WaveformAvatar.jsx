/**
 * WaveformAvatar.jsx — 沉浸式滿版波場（融合波形紀念畫面用）
 *
 * 手機版效能調校（跟桌機版 voice_clone_frontend/src/components/WaveformAvatar.jsx
 * 不再是「邏輯完全不變的移植」，這裡刻意做了幾個手機端專屬的效能優化，底層
 * 純函式 utils/waveformPath.js、utils/waveformSignature.js 仍然跟桌機版逐字
 * 一致，只有這個元件本身的渲染策略不同，原因：使用者實測回報手機上（尤其
 * iOS Safari）波紋動畫明顯卡頓）：
 *
 *   1. 拿掉 SVG feGaussianBlur 濾鏡的發光效果，改用「兩層不同寬度、低透明度
 *      的實心線條疊加」模擬類似的柔光暈開視覺。原因：feGaussianBlur 這種即時
 *      動畫濾鏡在手機瀏覽器非常吃效能——每一幀都要對濾鏡涵蓋的畫面區域重新
 *      光柵化＋模糊，這裡又是套在全螢幕大小的 SVG 上（見 pages/ResultPage.jsx
 *      的 position:fixed; inset:0），配合手機常見的 2~3 倍裝置像素比，等於
 *      每秒重複對一大片高解析度區域做模糊運算，桌機 Chrome 感覺不出來，手機
 *      上就很容易變成明顯掉幀。拿掉濾鏡、改用純線條疊加是同樣視覺意圖但
 *      幾乎零額外成本的做法。
 *   2. 波形帶數從桌機版的 5 條降到 3 條——每一條都要在每一幀重新用
 *      buildWavePath() 算一次座標、setAttribute 寫回 DOM，帶數越少，每幀
 *      要做的運算跟 DOM 寫入次數就越少。
 *   3. 每條波形線取樣點數從預設 40 點降到 24 點（buildWavePath 的 points
 *      參數），略減每幀的三角函數呼叫次數。
 *   4. 實際「重繪」（算路徑、寫入 DOM 屬性、套色）從每幀（~60fps）降到
 *      每隔一幀才做一次（~30fps）——人眼對這類平滑波動動畫在 30fps 已經
 *      感覺不出跟 60fps 的差異，但可以直接砍半這部分（原本最貴）的運算量。
 *      speakIntensity／signature 的漸變（lerp）刻意維持每幀更新、不受這個
 *      節流影響：這兩個 lerp 的收斂速度是「每呼叫一次前進 rate 比例」，不是
 *      以時間換算，如果連漸變本身都跟著降到 30fps 更新，會讓漸變的實際
 *      收斂時間變成兩倍慢，體感會跟桌機版不一致——所以只節流「畫出來」的
 *      部分，漸變狀態照常每幀推進。
 */

import { useEffect, useRef } from 'react'
import { buildWavePath, lerpTowards } from '../utils/waveformPath'
import { applyEmotionSignal, lerpSignatureTowards } from '../utils/waveformSignature'
import { analyzeTurnEmotion } from '../utils/emotionSignal'
import { buildWaveformColors } from '../utils/waveformColor'

const SPEAK_INTENSITY_LERP_RATE = 0.08
const SIGNATURE_LERP_RATE = 0.035

const VIEW_WIDTH = 240
const VIEW_HEIGHT = 140

// 手機版效能調校：帶數 5→3、取樣點數 40→24（見檔案開頭說明第 2、3 點）。
const BAND_COUNT = 3
const WAVE_POINTS = 24
const BANDS = Array.from({ length: BAND_COUNT }, (_, i) => {
  const t = i / (BAND_COUNT - 1)
  const distanceFromCenter = Math.abs(t - 0.5) * 2
  return {
    verticalOffsetFactor: (t - 0.5) * 0.66,
    ampScale: 1 - distanceFromCenter * 0.6,
    phaseOffset: i * 0.55,
    opacity: 0.16 + (1 - distanceFromCenter) * 0.42,
    lightnessOffset: i % 2 === 0 ? 4 : -4,
    isGlowSource: i === Math.floor((BAND_COUNT - 1) / 2),
  }
})

// 重繪節流：把「算路徑＋寫 DOM＋套色」這段最貴的工作從每幀降到約 30fps
// （見檔案開頭說明第 4 點）。
const PAINT_INTERVAL_MS = 1000 / 30

let instanceCounter = 0

export default function WaveformAvatar({ signature, isSpeaking, currentText }) {
  const bandPathRefs = useRef([])
  const glowOuterRef = useRef(null)
  const glowInnerRef = useRef(null)
  const bgStop0Ref = useRef(null)
  const bgStop1Ref = useRef(null)
  const speakIntensityRef = useRef(0)
  const effectiveSignatureRef = useRef(signature)
  const targetSignatureRef = useRef(signature)
  const startTimeRef = useRef(null)
  const lastPaintTimeRef = useRef(null)
  const rafIdRef = useRef(null)
  const isSpeakingRef = useRef(isSpeaking)

  const instanceIdRef = useRef(null)
  if (instanceIdRef.current === null) {
    instanceCounter += 1
    instanceIdRef.current = `wf-${instanceCounter}`
  }
  const gradientId = `${instanceIdRef.current}-bg`

  useEffect(() => {
    isSpeakingRef.current = isSpeaking
  }, [isSpeaking])

  useEffect(() => {
    effectiveSignatureRef.current = signature
    targetSignatureRef.current = applyEmotionSignal(signature, analyzeTurnEmotion(currentText))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  useEffect(() => {
    targetSignatureRef.current = applyEmotionSignal(signature, analyzeTurnEmotion(currentText))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentText])

  useEffect(() => {
    const animate = (timestamp) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp
      const time = (timestamp - startTimeRef.current) / 1000

      // 漸變狀態維持每幀更新，不受下面的重繪節流影響（見檔案開頭說明第 4 點）。
      const speakTarget = isSpeakingRef.current ? 1 : 0
      speakIntensityRef.current = lerpTowards(speakIntensityRef.current, speakTarget, SPEAK_INTENSITY_LERP_RATE)
      effectiveSignatureRef.current = lerpSignatureTowards(
        effectiveSignatureRef.current,
        targetSignatureRef.current,
        SIGNATURE_LERP_RATE,
      )

      const shouldPaint =
        lastPaintTimeRef.current === null || timestamp - lastPaintTimeRef.current >= PAINT_INTERVAL_MS

      if (shouldPaint) {
        lastPaintTimeRef.current = timestamp
        const speakIntensity = speakIntensityRef.current
        const effectiveSignature = effectiveSignatureRef.current

        const colors = buildWaveformColors({
          hue: effectiveSignature.hue,
          colorIntensity: effectiveSignature.colorIntensity,
        })
        if (bgStop0Ref.current) bgStop0Ref.current.setAttribute('stop-color', colors.bgStop0)
        if (bgStop1Ref.current) bgStop1Ref.current.setAttribute('stop-color', colors.bgStop1)

        BANDS.forEach((band, i) => {
          const d = buildWavePath({
            signature: effectiveSignature,
            time,
            speakIntensity,
            width: VIEW_WIDTH,
            height: VIEW_HEIGHT,
            points: WAVE_POINTS,
            phaseOffset: band.phaseOffset,
            verticalOffset: band.verticalOffsetFactor * VIEW_HEIGHT,
            ampScale: band.ampScale,
          })
          const el = bandPathRefs.current[i]
          if (el) {
            el.setAttribute('d', d)
            el.setAttribute('stroke', colors.bandColor(band.lightnessOffset))
          }
          if (band.isGlowSource) {
            // 無濾鏡的柔光暈開替代方案（見檔案開頭說明第 1 點）：兩層不同
            // 寬度/透明度的實心線條疊加同一條路徑，沒有濾鏡光柵化成本。
            if (glowOuterRef.current) {
              glowOuterRef.current.setAttribute('d', d)
              glowOuterRef.current.setAttribute('stroke', colors.glow)
            }
            if (glowInnerRef.current) {
              glowInnerRef.current.setAttribute('d', d)
              glowInnerRef.current.setAttribute('stroke', colors.glow)
            }
          }
        })
      }

      rafIdRef.current = requestAnimationFrame(animate)
    }

    rafIdRef.current = requestAnimationFrame(animate)
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
      startTimeRef.current = null
      lastPaintTimeRef.current = null
    }
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
      </defs>

      <rect x="0" y="0" width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${gradientId})`} />

      {/* 兩層無濾鏡的寬/低透明度線條疊加出柔光暈開的效果，取代原本的
          feGaussianBlur（見檔案開頭說明第 1 點）。 */}
      <path ref={glowOuterRef} fill="none" strokeWidth={isSpeaking ? 14 : 9} strokeLinecap="round" opacity={0.12} />
      <path ref={glowInnerRef} fill="none" strokeWidth={isSpeaking ? 7 : 4.5} strokeLinecap="round" opacity={0.22} />

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
