/**
 * CourtMicVisualizer.jsx — 口述證詞畫面的錄音視覺（canvas，真實麥克風音量驅動）
 *
 * 逐邏輯從最新設計稿「內在法庭_手機問卷 (17).html」的 drawMic() 搬過來。
 * 這是 v3 改版：v2 只畫一條單色真實波形；v3 改成「角色本尊」主視覺——
 * 開場畫面同一組座標資料（data/logoGlyph.js 的 TOP_DOTS／BOT_POLYS）畫出
 * 眼睛（會眨）、圓點弧上唇、串珠下顎，下顎隨音量往下（張嘴，mouthOpen 由
 * RMS 音量驅動、lerp 平滑），嘴裡的內容依狀態切換：
 *   - 錄音中：白色主波（真實聲音形狀）+ 極淡墨影墊底，講話時五條 OCEAN
 *     代表色的波跟著聲音起舞（micPresence 有聲浮現、安靜淡出）。
 *   - 待機：嘴裡是五條 OCEAN 波收攏呼吸（waveAt + flowGradO 沿線流動漸變，
 *     跟首頁主視覺同款）。
 *
 * ⚠ 構圖與設計稿座標一致（含「光學置中補償」的 mw*0.018 平移），不得自行
 * 改動；只有嘴的開合（gapPx）隨聲音變化。
 *
 * @param {{ analyserNode: AnalyserNode|null, recording: boolean }} props
 *   analyserNode 由呼叫端（pages/OnboardingFlow.jsx 的 startRecording）在
 *   建立 MediaStreamSource 時一併建立好傳進來，這個元件本身不碰
 *   getUserMedia/MediaRecorder，只負責畫圖，維持「錄音邏輯」跟「畫面呈現」
 *   分離。
 */
import { useEffect, useRef } from 'react'
import { DIMS } from '../data/oceanDims'
import { TOP_DOTS, BOT_POLYS, TOP_W, BOT_W, BOT_H } from '../data/logoGlyph'
import { TAU, lerp, hsb, waveAt, flowGradO, fitCanvas } from '../utils/courtVisuals'

export default function CourtMicVisualizer({ analyserNode, recording }) {
  const canvasRef = useRef(null)
  const rafIdRef = useRef(null)
  const startTimeRef = useRef(null)
  const dataArrayRef = useRef(null)
  // 跨幀狀態（設計稿的模組層級變數 micPresence / mouthOpen）：用 ref 保存，
  // 不用 state——每幀更新用 state 會造成整個元件不停 re-render。
  const micPresenceRef = useRef(0)
  const mouthOpenRef = useRef(0)

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

        // ── 音量偵測 ──
        let data = null
        let n = 0
        let rms = 0
        if (recording && analyserNode) {
          if (!dataArrayRef.current || dataArrayRef.current.length !== analyserNode.fftSize) {
            dataArrayRef.current = new Uint8Array(analyserNode.fftSize)
          }
          data = dataArrayRef.current
          analyserNode.getByteTimeDomainData(data)
          n = data.length
          let sumSq = 0
          for (let i = 0; i < n; i += 1) {
            const v = (data[i] - 128) / 128
            sumSq += v * v
          }
          rms = Math.sqrt(sumSq / n)
          const hasSound = rms > 0.035
          micPresenceRef.current = lerp(micPresenceRef.current, hasSound ? 1 : 0, hasSound ? 0.16 : 0.05)
        } else {
          micPresenceRef.current = 0
        }
        const targetOpen = recording ? Math.min(1, rms * 10) : 0.07 + 0.05 * Math.sin((t / 2.2) * TAU)
        mouthOpenRef.current = lerp(mouthOpenRef.current, targetOpen, recording ? 0.3 : 0.06)
        const micPresence = micPresenceRef.current
        const mouthOpen = mouthOpenRef.current

        // ── 角色本尊（Humble 定稿的主視覺）：眼睛在弧上方、點弧、五波之嘴、串珠下顎 ──
        const gapMax = 88
        const gapPx = 8 + mouthOpen * gapMax
        const mw = Math.min(W * 0.72, (H - gapMax - 24) / 0.9)
        const s1 = mw / TOP_W
        const s2 = mw / BOT_W
        const topH = mw * 0.505
        const botH = mw * (BOT_H / BOT_W)
        // 光學置中補償：角色筆畫左重右輕（原稿的書法性），幾何置中會視覺偏左。
        const ox = (W - mw) / 2 + mw * 0.018
        const oy = (H - (topH + gapPx + botH)) / 2

        // 眼睛：原稿雙環位置（弧上方），加粗、會眨
        const blink = t % 3.4 < 0.13 ? 0.12 : 1
        ctx.lineWidth = Math.max(2, 4.8 * s1)
        ctx.strokeStyle = 'rgba(77,77,77,.95)'
        for (const ex of [[139.7, 18.0], [317.2, 18.0]]) {
          ctx.save()
          ctx.translate(ox + ex[0] * s1, oy + ex[1] * s1)
          ctx.scale(1, blink)
          ctx.beginPath()
          ctx.arc(0, 0, 9.5 * s1, 0, TAU)
          ctx.stroke()
          ctx.restore()
        }

        // 上唇：圓點弧（原稿)
        for (let i = 0; i < TOP_DOTS.length; i += 1) {
          const dd = TOP_DOTS[i]
          ctx.fillStyle = 'rgba(77,77,77,.95)'
          ctx.beginPath()
          ctx.arc(ox + dd[0] * s1, oy + dd[1] * s1, Math.max(0.7, dd[2] * s1), 0, TAU)
          ctx.fill()
        }

        // 下顎：串珠弧（原稿），隨音量往下（張嘴）
        const botTop = oy + topH + gapPx
        for (let pi = 0; pi < BOT_POLYS.length; pi += 1) {
          const poly = BOT_POLYS[pi]
          ctx.fillStyle = 'rgba(77,77,77,.94)'
          ctx.beginPath()
          for (let j = 0; j < poly.length; j += 1) {
            const px = ox + poly[j][0] * s2
            const py = botTop + poly[j][1] * s2
            if (j === 0) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          }
          ctx.closePath()
          ctx.fill('evenodd')
        }

        // ── 嘴裡的五條波 ──
        const mouthTop = oy + topH
        const waveW = mw * 0.96
        const wx0 = (W - waveW) / 2 + mw * 0.018 // 跟臉同一個光學補償，波才會在嘴的正中

        if (recording && data) {
          // 錄音：白色主波（真實聲音形狀）+ 五色波跟著聲音起舞（micPresence 浮現）
          const mouthY = mouthTop + gapPx / 2
          const ampPx = gapPx * 0.55 + 7
          // 白色主波 + 極淡墨影墊底（白線在紙白/粉彩上都讀得到）
          const passes = [
            { w: 6.5, color: 'rgba(24,28,38,.14)' },
            { w: 2.1, color: 'rgba(255,255,255,.96)' },
          ]
          for (let p = 0; p < 2; p += 1) {
            ctx.lineWidth = passes[p].w
            ctx.strokeStyle = passes[p].color
            ctx.beginPath()
            for (let i = 0; i < n; i += 1) {
              const xn = i / (n - 1)
              const raw = (data[i] - 128) / 128
              const e = Math.pow(Math.sin(xn * Math.PI), 0.5)
              const y = mouthY + raw * ampPx * e
              const x = wx0 + xn * waveW
              if (i === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            }
            ctx.stroke()
          }
          if (micPresence > 0.01) {
            for (let d5 = 0; d5 < DIMS.length; d5 += 1) {
              const dim = DIMS[d5]
              ctx.lineWidth = 1.7
              ctx.strokeStyle = hsb(dim.hue, 88, 90, 0.72 * micPresence)
              ctx.beginPath()
              for (let i = 0; i < n; i += 1) {
                const xn = i / (n - 1)
                const raw = (data[i] - 128) / 128
                const weave = Math.sin(xn * TAU * (1.6 + d5 * 0.35) + t * 1.4 + d5 * 1.3) * 0.32 * micPresence
                const e = Math.pow(Math.sin(xn * Math.PI), 0.5)
                const y = mouthY + (raw + weave) * ampPx * e
                const x = wx0 + xn * waveW
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
              }
              ctx.stroke()
            }
          }
        } else {
          // 待機：嘴裡就是角色原樣的五條 OCEAN 波（收攏呼吸，等你開口）
          const innerGap = gapPx / 6
          const breathe = 0.85 + 0.15 * Math.sin((t / 2.6) * TAU)
          for (let d5 = 0; d5 < 5; d5 += 1) {
            const dim = DIMS[d5]
            const cy = mouthTop + innerGap * (d5 + 1)
            const amp = Math.min(innerGap * 0.55, 5) * breathe
            // 與首頁主視覺同款：沿線流動漸變，逐段上色
            ctx.lineWidth = 1.3
            let prevX = null
            let prevY = null
            for (let x = 0; x <= waveW; x += 5) {
              const xn = x / waveW
              const v = waveAt(dim, xn, t * 0.9 + d5 * 1.7)
              const y = cy + v * amp * Math.pow(Math.sin(xn * Math.PI), 0.4)
              if (prevX !== null) {
                const gg = flowGradO(dim.hue, xn, t, d5)
                ctx.strokeStyle = hsb(gg[0], gg[1], gg[2], 0.9)
                ctx.beginPath()
                ctx.moveTo(prevX, prevY)
                ctx.lineTo(wx0 + x, y)
                ctx.stroke()
              }
              prevX = wx0 + x
              prevY = y
            }
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
  }, [recording, analyserNode])

  return <canvas ref={canvasRef} className="micCanvas" />
}
