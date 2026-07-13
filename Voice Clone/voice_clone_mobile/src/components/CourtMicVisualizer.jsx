/**
 * CourtMicVisualizer.jsx — 口述證詞畫面的錄音波形（canvas，真實麥克風音量驅動）
 *
 * 逐邏輯從最新設計稿「內在法庭_手機問卷 (4).html」的 drawMic() 搬過來。
 * 這是 v2 改版：v1（inner-court-survey-fix8.html）版本錄音中會用 RMS 音量
 * 判斷有沒有聲音，有聲音才疊加五條 OCEAN 代表色的交錯波紋；v2 把這個效果
 * 整個拿掉，錄音中只畫一條單色真實波形（更克制、雜訊更少），待機時的合成波
 * 邏輯不變。這裡逐式對照過新版原始碼，不是自己簡化的。
 *
 * @param {{ analyserNode: AnalyserNode|null, recording: boolean }} props
 *   analyserNode 由呼叫端（pages/OnboardingFlow.jsx 的 startRecording）在
 *   建立 MediaStreamSource 時一併建立好傳進來，這個元件本身不碰
 *   getUserMedia/MediaRecorder，只負責畫圖，維持「錄音邏輯」跟「畫面呈現」
 *   分離。
 */
import { useEffect, useRef } from 'react'
import { TAU, fitCanvas } from '../utils/courtVisuals'

export default function CourtMicVisualizer({ analyserNode, recording }) {
  const canvasRef = useRef(null)
  const rafIdRef = useRef(null)
  const startTimeRef = useRef(null)
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

          ctx.strokeStyle = 'rgba(24,28,38,.85)'
          ctx.lineWidth = 1.4
          ctx.beginPath()
          for (let i = 0; i < n; i += 1) {
            const x = (i / (n - 1)) * W
            const y = H / 2 + ((data[i] - 128) / 128) * H * 0.42
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.stroke()
        } else {
          // 待機:合成波細線（跟審訊畫面同一套 waveAt() 波形函式概念相通，
          // 這裡沿用設計稿直接寫死的簡化雙正弦波，不是完整 waveAt()）。
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
