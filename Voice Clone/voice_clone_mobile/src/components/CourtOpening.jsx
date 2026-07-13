/**
 * CourtOpening.jsx — 開場畫面「WHOSE INNER...VOICE?」（逐邏輯移植設計稿的 drawOpening()）
 *
 * 使用者指出先前的簡化版開場（呼吸印章圓形記號）跟設計稿附圖的實際樣式
 * （頭像上弧點陣 + 雙環「眼睛」+ 五色 OCEAN 波「嘴」+ 頭像下弧多邊形 +
 * 「WHOSE INNER...VOICE?」標準字）對不上，這裡改成逐字元/逐邏輯移植：
 *   - 座標資料（LOGO_PIECES／TOP_DOTS／BOT_POLYS 等）是從設計稿原始檔
 *     byte-for-byte 抽出來的，見 data/logoGlyph.js 檔頭說明，沒有重新繕打
 *     或近似模擬任何一個數字。
 *   - 下面的 drawOpening() 渲染函式是設計稿同名函式的逐行移植，只把
 *     `var`/隱式全域狀態改寫成 React 的 useRef（explode／openPhase／
 *     leaveStart 三個值在設計稿裡是模組層級的可變變數，這裡改成 ref 存放，
 *     語意完全一致：每一幀讀寫同一個值，不觸發 React re-render，只有
 *     canvas 畫面本身在變化）。
 *   - 五色 OCEAN 波形段落沿用跟審訊畫面（CourtWaves.jsx）、代理人波形
 *     （AgentWaveCanvas.jsx）同一套 hsb/flowGrad/waveAt/vnoise 數學
 *     （utils/courtVisuals.js），三個畫面用的是同一顆函式，不是各自近似。
 *   - 觸摸/點擊後的「拉開」動畫（explode 0→1、標準字接力掃描上色、五聲
 *     和弦、2.4 秒後才進電子傳票畫面）數值逐一核對過跟設計稿一致
 *     （ENTER_DELAY_MS = 2400，對應設計稿註解「夾層拉開 + 標準字掃完
 *     （約 0.1×17 + 1.15 秒）才進傳票」）。
 */
import { useEffect, useRef } from 'react'
import { DIMS } from '../data/oceanDims'
import { LOGO_PIECES, LOGO_W, LOGO_H, TOP_DOTS, BOT_POLYS, TOP_W, BOT_W, BOT_H, HUES } from '../data/logoGlyph'
import { TAU, hsb, flowGrad, waveAt, vnoise, fitCanvas } from '../utils/courtVisuals'
import { ping, buzz } from '../utils/courtFeedback'

// 依 LOGO_PIECES 算出每個標準字碎片的重心/色相/隨機種子/散開方向，逐邏輯
// 移植設計稿的 pieceMeta 計算。資料是靜態匯入的，只需要在模組載入時算一次
// （跟設計稿在 <script> 頂層算一次、之後每幀重複使用同一份結果的行為一致）。
const pieceMeta = LOGO_PIECES.map((entry, i) => {
  const subs = entry[1]
  let sx = 0
  let sy = 0
  let n = 0
  for (let a = 0; a < subs.length; a += 1) {
    for (let b = 0; b < subs[a].length; b += 1) {
      sx += subs[a][b][0]
      sy += subs[a][b][1]
      n += 1
    }
  }
  const h = (i * 2654435761) % 4294967296
  const ang = (h % 6283) / 1000
  return { cx: sx / n, cy: sy / n, hue: HUES[i % HUES.length], seed: (h % 997) / 997, dirX: Math.cos(ang), dirY: Math.sin(ang) }
})

// 上括號的兩個環（設計稿註解：「雙環加粗，像一雙眼睛，可愛是刻意的」）。
const RINGS = [
  [139.7, 18.0],
  [317.2, 18.0],
]

const CHORD_SEQUENCE = ['C', 'N', 'A', 'O', 'E']
const ENTER_DELAY_MS = 2400

/** 散開包絡（設計稿 sweepEnv，彈簧落定曲線），逐式移植。 */
function sweepEnv(t, start, dur) {
  if (!Number.isFinite(start) || start < 0) return 0
  const p = (t - start) / dur
  if (p < 0 || p > 1) return 0
  if (p < 0.28) {
    const q = p / 0.28
    return 1 - (1 - q) ** 3
  }
  const q = (p - 0.28) / 0.72
  return Math.exp(-3.2 * q) * Math.cos(q * Math.PI * 1.6)
}

export default function CourtOpening({ onEnter }) {
  const canvasRef = useRef(null)
  const rafIdRef = useRef(null)
  // 對應設計稿模組層級的 let explode / openPhase / leaveStart：每幀讀寫，
  // 用 ref 存放才不會讓 canvas 動畫因為 React state 變化而多餘 re-render。
  const explodeRef = useRef(0)
  const openPhaseRef = useRef('idle') // 'idle' | 'leaving'
  const leaveStartRef = useRef(-99)

  useEffect(() => {
    const draw = (timestamp) => {
      // t 直接用 rAF 的 timestamp（跟 performance.now() 同一個時間基準），
      // 不像其他畫面元件那樣用 startTimeRef 歸零：因為 leaveStartRef 記錄的
      // 是「點擊當下的 performance.now()/1000」，t 一定要跟它同一個基準，
      // sweepEnv 的時間差計算才會對，這是跟設計稿的 t = performance.now()/1000
      // 完全一致的用法。
      const t = timestamp / 1000
      const cv = canvasRef.current
      const ctx = fitCanvas(cv)
      if (ctx) {
        drawOpening(ctx, cv, t, { explode: explodeRef, openPhase: openPhaseRef, leaveStart: leaveStartRef })
      }
      rafIdRef.current = requestAnimationFrame(draw)
    }
    rafIdRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  const handleEnter = () => {
    // 對應設計稿 enterFromOpening() 的 guard：已經在拉開動畫中就不重複觸發。
    if (openPhaseRef.current !== 'idle') return
    openPhaseRef.current = 'leaving'
    leaveStartRef.current = performance.now() / 1000
    buzz(10)
    // 分和弦：五音依五聲音階錯開響起（設計稿的聲音語言）。
    CHORD_SEQUENCE.forEach((key, i) => {
      setTimeout(() => ping(key), i * 110)
    })
    // 夾層拉開 + 標準字掃完才進電子傳票畫面。
    setTimeout(onEnter, ENTER_DELAY_MS)
  }

  return (
    <div
      className="court-step opening"
      onClick={handleEnter}
      onTouchEnd={(e) => {
        e.preventDefault()
        handleEnter()
      }}
    >
      <canvas ref={canvasRef} className="openCanvas" />
      <div className="openHint">觸 摸 開 庭</div>
    </div>
  )
}

/**
 * 逐邏輯移植設計稿的 drawOpening(t)：上弧圓點（頭像上緣）→ 雙環（眼睛）→
 * 五色 OCEAN 波（收攏態，跟審訊畫面共用同一套波形數學）→ 下弧多邊形
 * （頭像下緣）→ 標準字碎片（觸摸後接力掃描、由灰轉彩展開）。
 */
function drawOpening(ctx, cv, t, refs) {
  const W = cv.width
  const H = cv.height
  ctx.fillStyle = '#f2f3f5'
  ctx.fillRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'

  // 寬度取畫面寬與高度預算的較小者（展開狀態整組較高，先保證放得下）。
  const mw = Math.min(W * 0.86, H * 0.52)
  const ox = (W - mw) / 2
  const topH = mw * 0.505 + mw * 0.02
  const botH = mw * (BOT_H / BOT_W)

  // 觸摸後 explode 0→1：夾層拉開、括號分離、波幅放大。
  const isLeaving = refs.openPhase.current === 'leaving'
  refs.explode.current += ((isLeaving ? 1 : 0) - refs.explode.current) * 0.06
  const explode = refs.explode.current
  const leaveStart = refs.leaveStart.current

  const gap = mw * (0.028 + 0.075 * explode)
  const stackH = gap * 6
  const logoH = mw * (LOGO_H / LOGO_W)
  const totalH = topH + stackH + botH + logoH + mw * 0.03
  const oy = (H - totalH) / 2
  const breathe = 0.9 + 0.1 * Math.sin((t / 2.6) * TAU)

  const s1 = mw / TOP_W
  // 灰↔彩沿用同一顆 explode：平時紙灰、觸摸後隨標準字一起轉為純色。
  const cEdot = explode ** 2
  for (let i = 0; i < TOP_DOTS.length; i += 1) {
    const d = TOP_DOTS[i]
    const px = ox + d[0] * s1
    const py = oy + d[1] * s1
    const r = Math.max(0.8, d[2] * s1 * breathe)
    const hueD = HUES[i % HUES.length]
    const satD = 85 * cEdot
    const briD = 45 + 43 * cEdot
    ctx.fillStyle = hsb(hueD, satD, briD, 0.09 + 0.05 * cEdot)
    ctx.beginPath()
    ctx.arc(px, py, r * 3, 0, TAU)
    ctx.fill()
    ctx.fillStyle = hsb(hueD, satD, briD, 0.96)
    ctx.beginPath()
    ctx.arc(px, py, r, 0, TAU)
    ctx.fill()
  }

  // 上括號的兩個環，像一雙眼睛。
  ctx.lineWidth = Math.max(2.2, 4.8 * s1)
  ctx.strokeStyle = hsb(HUES[2], 85 * cEdot, 45 + 43 * cEdot, 0.92)
  for (let i = 0; i < RINGS.length; i += 1) {
    ctx.beginPath()
    ctx.arc(ox + RINGS[i][0] * s1, oy + RINGS[i][1] * s1, 9.5 * s1 * breathe, 0, TAU)
    ctx.stroke()
  }

  const stackTop = oy + topH
  for (let d = 0; d < 5; d += 1) {
    const dim = DIMS[d]
    const cy = stackTop + gap * (d + 1)
    const amp = dim.amplitude * mw * (0.032 + 0.05 * explode) * breathe
    const ph = t * 0.9 + d * 1.7
    const segN = 70

    // 三層筆觸 + 沿線流動漸變（逐段上色）。
    const gradSeg = (pts, alphaMul, wMul) => {
      const passes = [
        { w: 5.5, a: 0.05 },
        { w: 2.2, a: 0.13 },
        { w: 1.0, a: 0.62 },
      ]
      passes.forEach((pass) => {
        ctx.lineWidth = pass.w * (wMul || 1)
        for (let k = 0; k < pts.length - 1; k += 1) {
          const xn = k / (pts.length - 1)
          const [hh, bb] = flowGrad(dim.hue, xn, t, d)
          ctx.strokeStyle = hsb(hh, 88, bb, pass.a * (alphaMul || 1))
          ctx.beginPath()
          ctx.moveTo(pts[k][0], pts[k][1])
          ctx.lineTo(pts[k + 1][0], pts[k + 1][1])
          ctx.stroke()
        }
      })
    }
    const sampleW = (shapeMul, phOff, freqMul, yOff) => {
      const pts = []
      for (let k = 0; k <= segN; k += 1) {
        const xn = k / segN
        const e = Math.sin(xn * Math.PI) ** 0.4
        const v = waveAt(dim, xn, ph + (phOff || 0), shapeMul, freqMul || 1)
        pts.push([ox + xn * mw, cy + (yOff || 0) * e + v * amp * e])
      }
      return pts
    }

    if (dim.key === 'E') {
      const main = sampleW(1, 0)
      for (let k = 0; k < 2; k += 1) {
        const cyc = (t * 0.35 + k / 2) % 1
        const off = cyc * amp * 1.3
        const fade = (1 - cyc) ** 1.6 * 0.22
        if (fade > 0.02) {
          for (let dir = -1; dir <= 1; dir += 2) {
            ctx.lineWidth = 0.8
            for (let q = 0; q < main.length - 1; q += 1) {
              const xn = q / (main.length - 1)
              const e = Math.sin(xn * Math.PI) ** 0.4
              const [hh, bb] = flowGrad(dim.hue, xn, t, d)
              ctx.strokeStyle = hsb(hh, 82, bb, fade)
              ctx.beginPath()
              ctx.moveTo(main[q][0], main[q][1] + dir * off * e)
              ctx.lineTo(main[q + 1][0], main[q + 1][1] + dir * off * e)
              ctx.stroke()
            }
          }
        }
      }
      gradSeg(main, 1)
      for (let k = 0; k < 5; k += 1) {
        const u = (k + 0.5) / 5
        const tw = (0.5 + 0.5 * Math.sin(t * 2.2 + k * 1.9)) ** 2.4
        if (tw < 0.08) continue
        const idx = Math.floor(u * segN)
        const sx = main[idx][0]
        const sy = main[idx][1]
        const ln = 2.5 + 5 * tw
        ctx.strokeStyle = hsb(dim.hue, 78, 42, 0.85 * tw)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(sx - ln, sy)
        ctx.lineTo(sx + ln, sy)
        ctx.moveTo(sx, sy - ln)
        ctx.lineTo(sx, sy + ln)
        ctx.stroke()
        ctx.fillStyle = hsb(dim.hue, 70, 46, 0.7 * tw)
        ctx.beginPath()
        ctx.arc(sx, sy, 1.5 + 1.5 * tw, 0, TAU)
        ctx.fill()
      }
    } else if (dim.key === 'A') {
      gradSeg(sampleW(0.6, 0), 1)
      gradSeg(sampleW(0.6, Math.PI), 0.8)
    } else if (dim.key === 'C') {
      const off = Math.max(1.5, amp * 0.55)
      gradSeg(sampleW(0.4, 0, 1, -off), 0.4, 0.7)
      gradSeg(sampleW(0.4, 0, 1, off), 0.4, 0.7)
      gradSeg(sampleW(0.4, 0), 1)
    } else if (dim.key === 'N') {
      const pts = []
      const steps = 30
      for (let k = 0; k <= steps; k += 1) {
        const xn = k / steps
        const e = Math.sin(xn * Math.PI) ** 0.4
        let v = waveAt(dim, xn, ph)
        const nz = vnoise(xn * 9 + t * 1.3 + 50)
        if (nz > 0.72) v += (nz - 0.72) * 8 * (k % 2 === 0 ? 1 : -1)
        pts.push([ox + xn * mw, cy + v * amp * e])
      }
      gradSeg(pts, 1)
    } else if (dim.key === 'O') {
      gradSeg(sampleW(1, 0), 1)
      gradSeg(sampleW(1, 1.1, 1.6), 0.5, 0.7)
      gradSeg(sampleW(1, 2.2, 0.5), 0.5, 0.7)
    }
  }

  const s2 = mw / BOT_W
  const botTop = stackTop + stackH
  const cEpoly = explode ** 2
  for (let pi = 0; pi < BOT_POLYS.length; pi += 1) {
    const poly = BOT_POLYS[pi]
    const hueP = HUES[pi % HUES.length]
    ctx.fillStyle = hsb(hueP, 85 * cEpoly, 45 + 43 * cEpoly, 0.95)
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

  ctx.globalCompositeOperation = 'source-over'
  const logoTop = botTop + botH + mw * 0.03
  const ls = mw / LOGO_W
  const wobbleAmp = 0.28
  const wobbleSpeed = 4.2
  for (let i = 0; i < LOGO_PIECES.length; i += 1) {
    const g = LOGO_PIECES[i][0]
    const subs = LOGO_PIECES[i][1]
    const meta = pieceMeta[i]
    // 掃描：字首→字尾接力展開上色。
    const env = sweepEnv(t, leaveStart + g * 0.1, 1.15)
    const cEnv = Math.min(1, Math.abs(env))
    const bob = Math.sin(t * 2.2 + g * 1.3) * 0.35
    // 平時純灰（只留明度顆粒），掃描時跳到乾淨的品牌色再落回灰。
    const briG = 45 - 8 * (0.5 + 0.5 * Math.sin(meta.cx * 0.06 - t * 1.4)) - (0.5 - meta.cy / LOGO_H) * 5 + (meta.seed - 0.5) * 4
    const cE = cEnv ** 2
    const sat = 92 * cE
    const bri = briG + (90 - briG) * cE
    ctx.fillStyle = hsb(meta.hue, sat, Math.min(92, bri), 0.94)
    ctx.beginPath()
    for (let si = 0; si < subs.length; si += 1) {
      const sub = subs[si]
      for (let j = 0; j < sub.length; j += 1) {
        const px = sub[j][0]
        const py = sub[j][1]
        const wx =
          px +
          Math.sin(py * 0.9 + t * 1.8 * wobbleSpeed + meta.seed * 9) * wobbleAmp +
          meta.dirX * 10 * env * (0.5 + meta.seed)
        const wy =
          py +
          bob +
          Math.sin(px * 0.35 + t * 1.6 * wobbleSpeed + meta.seed * 7) * wobbleAmp +
          (meta.dirY * 0.5 - 0.8) * 10 * env * (0.5 + meta.seed)
        const X = ox + wx * ls
        const Y = logoTop + wy * ls
        if (j === 0) ctx.moveTo(X, Y)
        else ctx.lineTo(X, Y)
      }
      ctx.closePath()
    }
    ctx.fill('evenodd')
  }
}
