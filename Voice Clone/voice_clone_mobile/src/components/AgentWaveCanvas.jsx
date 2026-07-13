/**
 * AgentWaveCanvas.jsx — 「移送」畫面：主導人格（分數最高的向度）的波形
 *
 * 逐邏輯從設計稿 inner-court-survey-fix8.html 的 drawAgent() 搬過來（見該
 * 檔案「═══ 移送畫面:代理人的波 ═══」段落）。設計稿的「移送」畫面只是
 * 提示使用者「請收起手機、戴上 VR 頭盔」，還沒有實際串接後端；這個 app
 * 版本把同一個視覺效果沿用到問卷+錄音都完成、準備連結/已連結到主系統
 * session 的畫面，呈現「將代表你出庭辯論的訴訟代理人」是哪一個向度。
 *
 * @param {{ dim: {hue:number, frequency:number, shape:number} | null }} props
 *   dim 傳 null 時不畫任何東西（呼叫端還沒算出主導向度）。
 */
import { useEffect, useRef } from 'react'
import { hsb, flowGrad, waveAt, fitCanvas } from '../utils/courtVisuals'

export default function AgentWaveCanvas({ dim }) {
  const canvasRef = useRef(null)
  const rafIdRef = useRef(null)
  const startTimeRef = useRef(null)
  const dimRef = useRef(dim)
  dimRef.current = dim

  useEffect(() => {
    const draw = (timestamp) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp
      const t = (timestamp - startTimeRef.current) / 1000
      const cv = canvasRef.current
      const currentDim = dimRef.current
      if (cv && currentDim) {
        const ctx = fitCanvas(cv)
        if (ctx) {
          const W = cv.width
          const H = cv.height
          ctx.clearRect(0, 0, W, H)
          for (let pass = 0; pass < 2; pass += 1) {
            ctx.lineWidth = pass === 0 ? 3 : 1.4
            ctx.beginPath()
            for (let x = 0; x <= W; x += 4) {
              const xn = x / W
              const v = waveAt(currentDim, xn, t * 1.1) * Math.pow(Math.sin(xn * Math.PI), 0.5)
              const y = H / 2 + v * H * 0.36
              if (x === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            }
            const [hh, ss, bb] = flowGrad(currentDim.hue, 0.5, t, 0)
            ctx.strokeStyle = hsb(hh, ss, bb, pass === 0 ? 0.12 : 0.85)
            ctx.stroke()
          }
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
  }, [])

  return <canvas ref={canvasRef} className="agentWave" />
}
