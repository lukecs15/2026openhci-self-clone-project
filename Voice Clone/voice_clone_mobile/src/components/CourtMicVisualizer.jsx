/**
 * CourtMicVisualizer.jsx — 口述證詞畫面的錄音波形（canvas，真實麥克風音量驅動）
 *
 * 逐邏輯從設計稿 inner-court-survey-fix8.html 的 drawMic() 搬過來（見該檔案
 * 「═══ 口述證詞 ═══」段落）。錄音中：用 AnalyserNode 讀取即時波形資料，
 * 先畫一條「永遠都在」的單色真實波形，再用 RMS（均方根）音量判斷這一幀有
 * 沒有聲音——有聲音時，另外疊加五條 OCEAN 代表色的波紋（各自加一點相位/
 * 頻率偏移，跟真實波形交錯流動），音量降到接近無聲時五色波紋會自動淡出，
 * 只留單色線條；沒在錄音時，畫一條待機用的靜態合成波（沿用跟審訊畫面同一
 * 套 waveAt() 波形函式）。
 *
 * @param {{ analyserNode: AnalyserNode|null, recording: boolean }} props
 *   analyserNode 由呼叫端（pages/OnboardingFlow.jsx 的 startRecording）在
 *   建立 MediaStreamSource 時一併建立好傳進來，這個元件本身不碰
 *   getUserMedia/MediaRecorder，只負責畫圖，維持「錄音邏輯」跟「畫面呈現」
 *   分離。
 */
import { useEffect, useRef } from 'react'
import { DIMS } from '../data/oceanDims'
import { TAU, hsb, lerp, waveAt, fitCanvas } from '../utils/courtVisuals'

export default function CourtMicVisualizer({ analyserNode, recording }) {
  const canvasRef = useRef(null)
  const rafIdRef = useRef(null)
  const startTimeRef = useRef(null)
  const micPresenceRef = useRef(0)
  const dataArrayRef = useRef(null)

  useEffect(() => {
    const draw = (timestamp) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp
      const t = (timestamp - startTimeRef.current) / 1000
      const cv = canvasRef.current
      const ctx = fitCanvas(cv)
      if (ctx) {
        const W = cv.width
        const H = cv.height
        ctx.clearRect(0, 0, W, H)

        if (recording && analyserNode) {
          if (!dataArrayRef.current || dataArrayRef.current.length !== analyserNode.fftSize) {
            dataArrayRef.current = new Uint8Array(analyserNode.fftSize)
          }
          const data = dataArrayRef.current
          analyserNode.getByteTimeDomainData(data)
          const n = data.length

          let sumSq = 0
          for (let i = 0; i < n; i += 1) {
            const v = (data[i] - 128) / 128
            sumSq += v * v
          }
          const rms = Math.sqrt(sumSq / n)
          const hasSound = rms > 0.035
          micPresenceRef.current = lerp(micPresenceRef.current, hasSound ? 1 : 0, hasSound ? 0.16 : 0.05)
          const micPresence = micPresenceRef.current

          ctx.lineWidth = 1.4
          ctx.strokeStyle = 'rgba(24,28,38,.55)'
          ctx.beginPath()
          for (let i = 0; i < n; i += 1) {
            const xn = i / (n - 1)
            const raw = (data[i] - 128) / 128
            const y = H / 2 + raw * 0.34 * H
            const x = xn * W
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.stroke()

          if (micPresence > 0.01) {
            DIMS.forEach((dim, d) => {
              const weavePhase = d * 1.3
              ctx.lineWidth = 1.2
              ctx.strokeStyle = hsb(dim.hue, 58, 68, 0.78 * micPresence)
              ctx.beginPath()
              for (let i = 0; i < n; i += 1) {
                const xn = i / (n - 1)
                const raw = (data[i] - 128) / 128
                const weave = Math.sin(xn * TAU * (1.6 + d * 0.35) + t * 1.4 + weavePhase) * 0.1 * micPresence
                const y = H / 2 + (raw * 0.34 + weave) * H
                const x = xn * W
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
              }
              ctx.stroke()
            })
          }
        } else {
          micPresenceRef.current = 0
          ctx.strokeStyle = 'rgba(24,28,38,.35)'
          ctx.lineWidth = 1
          ctx.beginPath()
          for (let x = 0; x <= W; x += 5) {
            const xn = x / W
            const v = Math.sin(xn * TAU * 1.3 + t) * 0.4 + Math.sin(xn * TAU * 3 + t * 1.7) * 0.15
            const y = H / 2 + v * H * 0.2 * Math.pow(Math.sin(xn * Math.PI), 0.5)
            if (x === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.stroke()
        }
      }
      rafIdRef.current = requestAnimationFrame(draw)
    }

    rafIdRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
      startTimeRef.current = null
    }
  }, [recording, analyserNode])

  return <canvas ref={canvasRef} className="micCanvas" />
}
