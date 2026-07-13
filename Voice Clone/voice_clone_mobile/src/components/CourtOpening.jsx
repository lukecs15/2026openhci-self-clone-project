/**
 * CourtOpening.jsx — 開場畫面「WHOSE INNER...VOICE?」（逐邏輯移植設計稿的 drawOpening()）
 *
 * v2 改版（對應使用者上傳的最新設計稿「內在法庭_手機問卷 (4).html」，第一版
 * 是 inner-court-survey-fix8.html）。跟第一版比對後的重點差異：
 *   - 背景從紙白改成 85% 灰（#262626），配合下面新增的「Netflix 式」結局：
 *     標準字接力掃描完成後（leaveStart + 1.5 秒起算），鏡頭向畫面中心
 *     放大衝出（最高到 6.5 倍），五色 OCEAN 波同時炸開成 130 條扇形光纖
 *     （5 個向度 × 26 條），最後一層白光（#f2f3f5，跟主題紙白背景同色）
 *     蓋滿全螢幕淡入，完成「深底 → 紙白」的場景轉換，這樣切到電子傳票
 *     畫面時不會有色調突兀的跳接。
 *   - 新增 boom()：鏡頭放大衝出的同時彈一個低音（130.81Hz 滑落到
 *     65.4Hz，模仿 Netflix 片頭那種低頻「登」聲），在 leaveStart 之後
 *     1480ms 觸發。
 *   - 進場總延遲從 2400ms 延長到 2650ms，讓白光轉場完全落定後才切換到
 *     電子傳票畫面。
 *   - 二態配色（灰↔彩）的明度公式整個反過來：v1 是「灰態亮、彩態也還是
 *     偏暗」（因為紙白底要用深色描邊），v2 是「灰態跟彩態都維持高明度
 *     （87~96），只有飽和度在零與滿之間切換」，因為 v2 開場底色本身就是
 *     深灰，需要淺色線條才有對比。
 *
 * 沿用第一版就有的做法（這次沒變）：
 *   - 座標資料（LOGO_PIECES／TOP_DOTS／BOT_POLYS 等）是從設計稿原始檔
 *     byte-for-byte 抽出來的，見 data/logoGlyph.js 檔頭說明。
 *   - explode／openPhase／leaveStart 三個模組層級可變狀態改用 React
 *     useRef 存放，語意跟設計稿的模組層級 `let` 完全一致。
 *   - 五色 OCEAN 波形段落沿用跟審訊畫面（CourtWaves.jsx）、代理人波形
 *     （AgentWaveCanvas.jsx）同一套 hsb/waveAt/vnoise 數學
 *     （utils/courtVisuals.js）；這次新增的 flowGradO 是開場專用的流動
 *     漸層（跟 flowGrad 同一套時間/相位公式，只是亮度區間不同），也放在
 *     同一個共用檔案裡，不是這個檔案自己土砲一份。
 */
import { useEffect, useRef } from 'react'
import { DIMS } from '../data/oceanDims'
import { LOGO_PIECES, LOGO_W, LOGO_H, TOP_DOTS, BOT_POLYS, TOP_W, BOT_W, BOT_H, HUES } from '../data/logoGlyph'
import { TAU, hsb, flowGradO, waveAt, vnoise, fitCanvas } from '../utils/courtVisuals'
import { ping, getAudioContext } from '../utils/courtFeedback'

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
const ENTER_DELAY_MS = 2650 // 夾層拉開 + 標準字掃完 + 白光落定後才進傳票
const BOOM_DELAY_MS = 1480 // 鏡頭放大衝出同時的低音轟鳴

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

/** 低音轟鳴（設計稿的 boom()，Netflix ta-dum 位），逐式移植。 */
function boom() {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') ctx.resume()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = 130.81 // C3 滑落一個八度
    o.frequency.exponentialRampToValueAtTime(65.4, ctx.currentTime + 0.8)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.06)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.0)
    o.connect(g)
    g.connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 1.05)
  } catch {
    // 音效播放失敗不影響任何實際功能，安靜地忽略即可。
  }
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
    setTimeout(boom, BOOM_DELAY_MS)
    // 分和弦：五音依五聲音階錯開響起（設計稿的聲音語言）。
    CHORD_SEQUENCE.forEach((key, i) => {
      setTimeout(() => ping(key), i * 110)
    })
    // 夾層拉開 + 標準字掃完 + 白光落定後才進電子傳票畫面。
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
 * 逐邏輯移植設計稿的 drawOpening(t)：85% 灰底 → 上弧圓點（頭像上緣）→
 * 雙環（眼睛）→ 五色 OCEAN 波（收攏態，跟審訊畫面共用同一套波形數學）→
 * 光纖爆發層（鏡頭放大衝出時才出現）→ 下弧多邊形（頭像下緣）→ 標準字碎片
 * （觸摸後接力掃描、由灰轉彩展開）→ 白光轉場。
 */
function drawOpening(ctx, cv, t, refs) {
  const W = cv.width
  const H = cv.height
  ctx.fillStyle = '#262626' // 85% 灰
  ctx.fillRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'

  const isLeaving = refs.openPhase.current === 'leaving'
  const leaveStart = refs.leaveStart.current

  // ── Netflix 式開場:掃描演完後,標誌向鏡頭放大衝出,白光穿透接到傳票 ──
  const tS = isLeaving ? t - leaveStart : 0
  const zp = Math.min(1, Math.max(0, (tS - 1.5) / 0.95))
  const ze = zp * zp * (3 - 2 * zp) // smoothstep
  ctx.save()
  if (ze > 0) {
    const k = 1 + ze * ze * 5.5 // 向觀者放大
    ctx.translate(W / 2, H / 2)
    ctx.scale(k, k)
    ctx.translate(-W / 2, -H / 2)
  }

  // 寬度取畫面寬與高度預算的較小者（展開狀態整組較高，先保證放得下）。
  const mw = Math.min(W * 0.86, H * 0.52)
  const ox = (W - mw) / 2
  const topH = mw * 0.505 + mw * 0.02
  const botH = mw * (BOT_H / BOT_W)

  // 觸摸後 explode 0→1：夾層拉開、括號分離、波幅放大。
  refs.explode.current += ((isLeaving ? 1 : 0) - refs.explode.current) * 0.06
  const explode = refs.explode.current

  const gap = mw * (0.028 + 0.075 * explode)
  const stackH = gap * 6
  const logoH = mw * (LOGO_H / LOGO_W)
  const totalH = topH + stackH + botH + logoH + mw * 0.03
  const oy = (H - totalH) / 2
  const breathe = 0.9 + 0.1 * Math.sin((t / 2.6) * TAU)
  const cEdot = explode ** 2 // 彩球包絡:觸摸開庭,顏色甦醒(二態瞬切)

  const s1 = mw / TOP_W
  for (let i = 0; i < TOP_DOTS.length; i += 1) {
    const d = TOP_DOTS[i]
    const px = ox + d[0] * s1
    const py = oy + d[1] * s1
    const r = Math.max(0.8, d[2] * s1 * breathe)
    const hueD = HUES[i % HUES.length]
    // 二態:待機 = 紙灰(零飽和);開庭 = 純彩(五色沿弧輪循);光暈已移除。
    ctx.fillStyle = hsb(hueD, 85 * cEdot, 92 - 4 * cEdot, 0.96)
    ctx.beginPath()
    ctx.arc(px, py, r, 0, TAU)
    ctx.fill()
  }

  // 上括號的兩個環，像一雙眼睛。
  ctx.lineWidth = Math.max(2.2, 4.8 * s1)
  ctx.strokeStyle = hsb(HUES[2], 85 * cEdot, 92 - 4 * cEdot, 0.92) // 眼睛開庭時染紫
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
          const [hh, ss, bb] = flowGradO(dim.hue, xn, t, d)
          ctx.strokeStyle = hsb(hh, ss, bb, pass.a * (alphaMul || 1))
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
              const [hh, ss, bb] = flowGradO(dim.hue, xn, t, d)
              ctx.strokeStyle = hsb(hh, ss, bb, fade)
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
        ctx.strokeStyle = hsb(dim.hue, 88, 94, 0.9 * tw)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(sx - ln, sy)
        ctx.lineTo(sx + ln, sy)
        ctx.moveTo(sx, sy - ln)
        ctx.lineTo(sx, sy + ln)
        ctx.stroke()
        ctx.fillStyle = hsb(dim.hue, 75, 96, 0.75 * tw)
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

  // ── 光纖爆發層(Netflix 質感的來源是數量):zoom 時五波炸開成 130 條絲線 ──
  if (ze > 0.02) {
    const strandsPer = 26
    const fadeIn = Math.min(1, ze * 3)
    ctx.lineWidth = 1.1
    for (let d5 = 0; d5 < 5; d5 += 1) {
      const dimF = DIMS[d5]
      const cyd = stackTop + gap * (d5 + 1)
      const ampF = dimF.amplitude * mw * 0.07 * (1 + ze * 2.2)
      for (let k = 0; k < strandsPer; k += 1) {
        const jit = Math.abs((Math.sin((d5 * 131 + k) * 12.9898) * 43758.5453) % 1)
        const off = (k / (strandsPer - 1) - 0.5) * 2 // -1 ~ 1:扇形展開位
        const yC = cyd + off * H * 0.6 * ze * (0.35 + 0.65 * jit)
        const ph2 = t * (0.9 + ze * 3.2) + d5 * 1.7 + jit * 6.283
        const x0f = ox - mw * ze * 0.7
        const x1f = ox + mw + mw * ze * 0.7 // 水平拉長成光紋
        ctx.strokeStyle = hsb(
          (dimF.hue + (jit - 0.5) * 18 + 360) % 360,
          70 + 26 * jit,
          88 + 7 * jit,
          (0.05 + 0.24 * (1 - Math.abs(off) * 0.7)) * fadeIn,
        )
        ctx.beginPath()
        for (let q = 0; q <= 26; q += 1) {
          const xn = q / 26
          const x = x0f + xn * (x1f - x0f)
          const v = waveAt(dimF, xn, ph2, 1, 1 + jit * 1.5)
          const e = Math.sin(xn * Math.PI) ** 0.35
          const y = yC + v * ampF * e
          if (q === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
    }
  }

  const s2 = mw / BOT_W
  const botTop = stackTop + stackH
  for (let pi = 0; pi < BOT_POLYS.length; pi += 1) {
    const poly = BOT_POLYS[pi]
    // 串珠同樣二態:待機紙灰 → 開庭沿弧輪循五色。
    ctx.fillStyle = hsb(HUES[pi % HUES.length], 85 * cEdot, 92 - 4 * cEdot, 0.94)
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
    // 灰底反轉:平時亮灰(82~92,深底才看得見),掃描時跳到乾淨的品牌色再落回灰。
    const briG = 82 + 10 * (0.5 + 0.5 * Math.sin(meta.cx * 0.06 - t * 1.4)) + (0.5 - meta.cy / LOGO_H) * 5 + (meta.seed - 0.5) * 4
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
  ctx.restore()

  if (ze > 0) {
    // 白光穿透:高潮同時完成深底 → 紙白的場景轉換。
    ctx.fillStyle = `rgba(242,243,245,${ze ** 1.7})`
    ctx.fillRect(0, 0, W, H)
  }
}
