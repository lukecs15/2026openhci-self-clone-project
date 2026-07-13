/**
 * CourtWaves.jsx — 審訊畫面的五色 OCEAN 波形（canvas，即時反映作答狀況）
 *
 * 逐邏輯從設計稿 inner-court-survey-fix8.html 的 drawWaves() 搬過來（見該
 * 檔案「═══ 審訊畫面:五波 ═══」段落）。五條波形帶由上到下對應 OCEAN
 * 五個向度（data/oceanDims.js 的 DIMS），每答一題：
 *   - 該向度的 sum/count 累加，target.waveHeight／target.amplitude 依目前
 *     平均分數重新計算（分數越高 → 波幅越大越明顯）。
 *   - current 值每幀用 lerp 平滑追向 target（不是瞬間跳變）。
 *   - pulse 瞬間拉到 1、之後每幀衰減（*0.94），驅動短暫的「答題脈衝」視覺
 *     （波形短暫放大、發亮）。
 *   - certainty = count / PER_DIM，還沒答滿 3 題的向度波形會帶一點噪點
 *     霧感（vnoise），答滿之後霧感完全消失、線條變得篤定。
 *
 * 用 forwardRef + useImperativeHandle 暴露 pulse(dimKey) 給呼叫端
 * （pages/OnboardingFlow.jsx 的 handleAnswer）在使用者剛答完某一題的當下
 * 直接觸發對應向度的脈衝——這樣「答了哪一題」跟「畫面怎麼反應」的因果關係
 * 是呼叫端明確觸發的，不是靠這個元件自己去 diff answers 物件猜測，邏輯上
 * 更直接也更不容易出錯。
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { BIG_FIVE_QUESTIONS } from '../data/bigFiveQuestions'
import { DIMS, PER_DIM, findDimIndexByKey } from '../data/oceanDims'
import { TAU, clamp, lerp, hsb, flowGrad, waveAt, vnoise, fitCanvas } from '../utils/courtVisuals'

function buildInitialState() {
  return DIMS.map((d) => ({
    sum: 0,
    count: 0,
    pulse: 0,
    current: { waveHeight: 0.55, amplitude: d.amplitude * 0.55 },
    target: { waveHeight: 0.55, amplitude: d.amplitude * 0.55 },
  }))
}

/** 依目前 answers 快照，重算每個向度的 sum/count/target（不含 pulse，pulse 由 pulse() 觸發）。 */
function recomputeFromAnswers(stateArr, answers) {
  const sums = DIMS.map(() => 0)
  const counts = DIMS.map(() => 0)
  BIG_FIVE_QUESTIONS.forEach((q) => {
    const raw = answers[q.id]
    if (raw === undefined || raw === null) return
    const scored = q.reverse ? 6 - raw : raw
    const dimIdx = findDimIndexByKey(q.dim)
    if (dimIdx < 0) return
    sums[dimIdx] += scored
    counts[dimIdx] += 1
  })
  stateArr.forEach((s, i) => {
    s.sum = sums[i]
    s.count = counts[i]
    if (counts[i] > 0) {
      const tScore = (sums[i] / counts[i] - 1) / 4
      s.target = {
        waveHeight: 0.4 + 0.6 * tScore,
        amplitude: DIMS[i].amplitude * (0.6 + 0.8 * tScore),
      }
    }
  })
}

const CourtWaves = forwardRef(function CourtWaves({ answers }, ref) {
  const canvasRef = useRef(null)
  const stateRef = useRef(buildInitialState())
  const rafIdRef = useRef(null)
  const startTimeRef = useRef(null)

  useImperativeHandle(
    ref,
    () => ({
      pulse(dimKey) {
        const idx = findDimIndexByKey(dimKey)
        if (idx >= 0) stateRef.current[idx].pulse = 1
      },
    }),
    [],
  )

  useEffect(() => {
    recomputeFromAnswers(stateRef.current, answers)
  }, [answers])

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
        const bandH = H / 5

        DIMS.forEach((dim, i) => {
          const s = stateRef.current[i]
          s.pulse *= 0.94
          s.current.waveHeight = lerp(s.current.waveHeight, s.target.waveHeight, 0.05)
          s.current.amplitude = lerp(s.current.amplitude, s.target.amplitude, 0.05)
          const cy = bandH * (i + 0.5)
          const certainty = clamp(s.count / PER_DIM, 0, 1)
          const mist = (1 - certainty) * 0.5
          const breathe = 0.85 + 0.15 * Math.sin((t / 2.6) * TAU)
          const speak = 1 + s.pulse * 0.8
          const ph = t * (0.9 + s.pulse * 1.3) + i * 1.9
          const amp = s.current.amplitude * (bandH / 2) * s.current.waveHeight * breathe * speak * 1.25
          const glow = 0.35 + s.pulse * 0.65
          const alphaMul = 0.72 + 0.28 * certainty

          const seg = (pts, w, aBase) => {
            ctx.lineWidth = w
            for (let k = 0; k < pts.length - 1; k += 1) {
              const xn = k / (pts.length - 1)
              const [hh, bb] = flowGrad(dim.hue, xn, t, i)
              ctx.strokeStyle = hsb(hh, 90, Math.max(bb - 8 * glow, 46), aBase * alphaMul)
              ctx.beginPath()
              ctx.moveTo(pts[k][0], pts[k][1])
              ctx.lineTo(pts[k + 1][0], pts[k + 1][1])
              ctx.stroke()
            }
          }
          const sample = (shapeMul, phOff, freqMul = 1, yOff = 0) => {
            const pts = []
            for (let x = 0; x <= W; x += 7) {
              const xn = x / W
              let v = waveAt(dim, xn, ph + phOff, shapeMul, freqMul)
              v += (vnoise(xn * 3.5 + i * 40 + t * 0.6) * 2 - 1) * mist
              pts.push([x, cy + yOff + v * amp])
            }
            return pts
          }

          const main = sample(dim.key === 'C' ? 0.4 : dim.key === 'A' ? 0.6 : 1, 0)
          seg(main, 3.0, 0.13)
          seg(main, 1.5, 0.72)

          if (certainty > 0.05) {
            if (dim.key === 'A') {
              const b = sample(0.6, Math.PI)
              seg(b, 1.1, 0.4 * certainty)
            }
            if (dim.key === 'C') {
              const off = Math.max(2.5, amp * 0.55)
              seg(sample(0.4, 0, 1, -off), 0.9, 0.28 * certainty)
              seg(sample(0.4, 0, 1, off), 0.9, 0.28 * certainty)
            }
            if (dim.key === 'O') {
              seg(sample(1, 1.1, 1.6), 0.9, 0.3 * certainty)
              seg(sample(1, 2.2, 0.5), 0.9, 0.3 * certainty)
            }
            if (dim.key === 'E') {
              for (let k = 0; k < 4; k += 1) {
                const u = (k + 0.5) / 4
                const tw = Math.pow(0.5 + 0.5 * Math.sin(t * 2.2 + k * 1.9), 2.4) * certainty
                if (tw < 0.08) continue
                const idx = Math.floor(u * (main.length - 1))
                const [px, py] = main[idx]
                const ln = 3 + 6 * tw
                ctx.strokeStyle = hsb(dim.hue, 78, 42, 0.85 * tw)
                ctx.lineWidth = 1.1
                ctx.beginPath()
                ctx.moveTo(px - ln, py)
                ctx.lineTo(px + ln, py)
                ctx.moveTo(px, py - ln)
                ctx.lineTo(px, py + ln)
                ctx.stroke()
              }
            }
          }

          ctx.fillStyle = hsb(dim.hue, 70, 40, 0.3 + 0.55 * certainty)
          ctx.font = '11px "Noto Sans TC", sans-serif'
          ctx.fillText(dim.label, 12, cy - bandH * 0.3)
          ctx.fillStyle = hsb(dim.hue, 60, 42, 0.22 + 0.4 * certainty)
          ctx.font = '8px ui-monospace, monospace'
          ctx.fillText(dim.en.toUpperCase(), 12, cy - bandH * 0.3 + 11)
        })
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

  return <canvas ref={canvasRef} className="waves" />
})

export default CourtWaves
