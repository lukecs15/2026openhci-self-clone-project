/**
 * lineOrbRenderer.js — 「五人格線條球（Line Orbs）」canvas 2D 渲染器
 *
 * 依附件《波形設計》(p5 sketch v48) 逐段移植成無依賴的 canvas 2D 實作：
 *   - 多條細環繞成一顆「看似球」的形，中間一條清晰的主波 = 聲音的簽章
 *   - 五種骨架（環怎麼繞 = 性格）：
 *       E 外向（黃綠）= 環由內往外一圈圈擴散消散；主波帶星芒
 *       A 親和（暖橘）= 環成對出現、傾角互為鏡像（彼此環抱）；雙股主波
 *       C 盡責（紫）  = 緯度環：平行等距的一疊（秩序）；主波帶上下細軌
 *       N 負向（紅）  = 環的傾角凌亂、線上帶抖動；主波鋸齒帶尖峰
 *       O 開放（藍）  = 大圓環在許多不同傾角上交錯；三條頻率不同的諧波干涉
 *   - 深度：環的後半變暗變細（透視穿過，無實體球遮擋）
 *   - 中心柔光核心（層疊光暈 + 近白亮心）隨呼吸微縮放
 *   - 「說話」三件套：核心以語音包絡顫動、聲納漣漪、主波振幅抖動
 *
 * 與 p5 版的差異：
 *   - 「說話」的驅動不再是滑鼠靠近/鍵盤，而是真實 TTS 播放能量
 *     （useDebateSession.getSpeakLevel()），speak 介面維持 0~1
 *   - p5 的 noise() 用輕量 value-noise 近似（視覺用途，不需要嚴格 Perlin）
 */

export const ORB_CONFIG = {
  bg: '#05070d',
  orbRadius: 0.14, // 球半徑（相對畫面短邊；兩顆並排所以比五顆版大一點）
  viewTilt: 0.32,
  perspective: 0.12,
  ringSegs: 90,
  precess: 0.22,
  mainWaveAmp: 0.34,
  whitePeak: 0.55,
}

const TWO_PI = Math.PI * 2
const { sin, cos, floor, pow, abs, min, max } = Math

// ─── 輕量 value noise（近似 p5 noise，視覺用途足夠） ─────────────────────
function hash1(n) {
  const s = sin(n * 127.1 + 311.7) * 43758.5453
  return s - floor(s)
}
function smooth(t) {
  return t * t * (3 - 2 * t)
}
export function noise(x, y = 0, z = 0) {
  const xi = floor(x)
  const yi = floor(y)
  const zi = floor(z)
  const xf = smooth(x - xi)
  const yf = smooth(y - yi)
  const zf = smooth(z - zi)
  const n = (ix, iy, iz) => hash1(ix * 157 + iy * 113 + iz * 271)
  const lerp = (a, b, t) => a + (b - a) * t
  const v00 = lerp(n(xi, yi, zi), n(xi + 1, yi, zi), xf)
  const v10 = lerp(n(xi, yi + 1, zi), n(xi + 1, yi + 1, zi), xf)
  const v01 = lerp(n(xi, yi, zi + 1), n(xi + 1, yi, zi + 1), xf)
  const v11 = lerp(n(xi, yi + 1, zi + 1), n(xi + 1, yi + 1, zi + 1), xf)
  return lerp(lerp(v00, v10, yf), lerp(v01, v11, yf), zf)
}

function lerp(a, b, t) {
  return a + (b - a) * t
}
function mapRange(v, a, b, c, d) {
  return c + ((v - a) / (b - a)) * (d - c)
}

// ─── HSB(360,100,100,100) → rgba() 字串（對齊 p5 colorMode） ─────────────
function hsbToRgba(h, s, b, a) {
  const hh = (((h % 360) + 360) % 360) / 60
  const ss = max(0, min(100, s)) / 100
  const bb = max(0, min(100, b)) / 100
  const c = bb * ss
  const x = c * (1 - abs((hh % 2) - 1))
  const m = bb - c
  let r = 0
  let g = 0
  let bl = 0
  if (hh < 1) [r, g, bl] = [c, x, 0]
  else if (hh < 2) [r, g, bl] = [x, c, 0]
  else if (hh < 3) [r, g, bl] = [0, c, x]
  else if (hh < 4) [r, g, bl] = [0, x, c]
  else if (hh < 5) [r, g, bl] = [x, 0, c]
  else [r, g, bl] = [c, 0, x]
  const alpha = max(0, min(100, a)) / 100
  return `rgba(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((bl + m) * 255)},${alpha.toFixed(3)})`
}

// 每種骨架的主波參數（對齊附件 DIMS 的 frequency/shape）
export const ORB_STYLES = {
  E: { frequency: 1.8, shape: 0.45, defaultHue: 95 },
  A: { frequency: 1.0, shape: 0.2, defaultHue: 34 },
  C: { frequency: 1.3, shape: 0.12, defaultHue: 255 },
  N: { frequency: 2.4, shape: 0.75, defaultHue: 350 },
  O: { frequency: 0.7, shape: 0.6, defaultHue: 200 },
}

// ─── 3D 投影（手算，2D 模式） ─────────────────────────────────────────────
function proj(cx, cy, R, x, y, z, rotY) {
  const x1 = x * cos(rotY) + z * sin(rotY)
  const z1 = -x * sin(rotY) + z * cos(rotY)
  const y2 = y * cos(ORB_CONFIG.viewTilt) - z1 * sin(ORB_CONFIG.viewTilt)
  const z2 = y * sin(ORB_CONFIG.viewTilt) + z1 * cos(ORB_CONFIG.viewTilt)
  const persp = 1 + (z2 / R) * ORB_CONFIG.perspective
  return [cx + x1 * persp, cy + y2 * persp, z2 / R]
}

/** 畫一條環（深度決定明暗粗細）。 */
function drawRing(ctx, cx, cy, R, hue, rotY, alphaMul, weight, pointFn) {
  let prev = null
  for (let i = 0; i <= ORB_CONFIG.ringSegs; i += 1) {
    const thN = i / ORB_CONFIG.ringSegs
    const [lx, ly, lz] = pointFn(thN)
    const [sx, sy, depth] = proj(cx, cy, R, lx, ly, lz, rotY)
    if (prev) {
      const d = (prev[2] + depth) / 2
      const dm = mapRange(d, -1, 1, 0.28, 1)
      ctx.strokeStyle = hsbToRgba(hue, 72, 40 + 42 * dm, 62 * alphaMul * dm)
      ctx.lineWidth = weight * (0.6 + 0.4 * dm)
      ctx.beginPath()
      ctx.moveTo(prev[0], prev[1])
      ctx.lineTo(sx, sy)
      ctx.stroke()
    }
    prev = [sx, sy, depth]
  }
}

// ─── 五種環群（骨架 = 性格） ──────────────────────────────────────────────
function drawCage(ctx, styleKey, hue, cx, cy, R, t, sp) {
  const spin = t * ORB_CONFIG.precess * (1 + sp * 1.5)
  switch (styleKey) {
    case 'E': {
      for (let k = 0; k < 6; k += 1) {
        const cyc = (t * 0.22 + k / 6) % 1
        const r = R * (0.55 + cyc * 0.75)
        const fade = pow(1 - cyc, 1.4)
        const tilt = 0.5 + k * 0.16
        drawRing(ctx, cx, cy, R, hue, spin + k, fade * 0.9, 1.1, (thN) => {
          const th = thN * TWO_PI
          return [cos(th) * r, sin(th) * r * cos(tilt), sin(th) * r * sin(tilt)]
        })
      }
      break
    }
    case 'A': {
      for (let k = 0; k < 3; k += 1) {
        const tilt = 0.35 + k * 0.3
        for (const dir of [1, -1]) {
          drawRing(ctx, cx, cy, R, hue, spin + k * 0.8, 0.75, 1.1, (thN) => {
            const th = thN * TWO_PI
            return [cos(th) * R, sin(th) * R * cos(tilt * dir), sin(th) * R * sin(tilt * dir)]
          })
        }
      }
      break
    }
    case 'C': {
      const lats = 7
      for (let k = 0; k < lats; k += 1) {
        const lat = mapRange(k, 0, lats - 1, -1.05, 1.05)
        const r = R * cos(lat)
        const yOff = R * sin(lat)
        drawRing(ctx, cx, cy, R, hue, spin, k === floor(lats / 2) ? 1 : 0.6, 1.1, (thN) => {
          const th = thN * TWO_PI
          return [cos(th) * r, yOff, sin(th) * r]
        })
      }
      break
    }
    case 'N': {
      for (let k = 0; k < 7; k += 1) {
        const tilt = noise(k * 7.7) * Math.PI
        const wob = 0.06 + 0.05 * noise(k * 3.1, t * 0.5)
        drawRing(ctx, cx, cy, R, hue, spin * (0.6 + noise(k) * 1.2) + k, 0.8, 1.0, (thN) => {
          const th = thN * TWO_PI
          const jitter = 1 + (noise(thN * 6, k * 9, t * 0.8) - 0.5) * wob * 4
          const r = R * jitter
          return [cos(th) * r, sin(th) * r * cos(tilt), sin(th) * r * sin(tilt)]
        })
      }
      break
    }
    case 'O':
    default: {
      for (let k = 0; k < 9; k += 1) {
        const tilt = (k / 9) * Math.PI
        drawRing(ctx, cx, cy, R, hue, spin * (0.7 + (k % 3) * 0.3) + k * 0.7, 0.7, 1.0, (thN) => {
          const th = thN * TWO_PI
          return [cos(th) * R, sin(th) * R * cos(tilt), sin(th) * R * sin(tilt)]
        })
      }
      break
    }
  }
}

// ─── 語音包絡：真實播放能量優先，沒有能量訊號時退回合成包絡 ────────────────
function voiceEnvSynthetic(t, seed) {
  return 0.55 + 0.45 * abs(sin(t * 8.7 + seed * 3.1) * sin(t * 13.3 + seed * 7.7))
}

// ─── 中心光球：層疊柔光 + 近白亮心；說話時以語音包絡顫動 ──────────────────
function drawCore(ctx, hue, cx, cy, R, t, sp, idx, env) {
  const breathe = 0.92 + 0.08 * sin((t / 2.6) * TWO_PI + idx * 1.3)
  const coreR = R * 0.42 * breathe * (0.9 + 0.25 * sp) * env
  const layers = 8
  for (let i = layers; i >= 1; i -= 1) {
    const f = i / layers
    ctx.fillStyle = hsbToRgba(hue, 62 - 30 * (1 - f), 55 + 40 * (1 - f), (2.6 + sp * 3.2) * env)
    ctx.beginPath()
    ctx.arc(cx, cy, (coreR * 2.4 * f) / 2, 0, TWO_PI)
    ctx.fill()
  }
  ctx.fillStyle = hsbToRgba(hue, 14, 100, (30 + sp * 45) * env)
  ctx.beginPath()
  ctx.arc(cx, cy, (coreR * 0.55) / 2, 0, TWO_PI)
  ctx.fill()

  // 聲納漣漪：說話時從球心一圈圈打出去
  if (sp > 0.05) {
    for (let k = 0; k < 3; k += 1) {
      const cyc = (t * 0.85 + k / 3) % 1
      const rr = R * (0.3 + cyc * 1.15)
      const a = pow(1 - cyc, 1.6) * 46 * sp
      if (a < 1.5) continue
      ctx.strokeStyle = hsbToRgba(hue, 55, 92, a)
      ctx.lineWidth = 1.4 * (1 - cyc) + 0.4
      ctx.beginPath()
      ctx.arc(cx, cy, rr, 0, TWO_PI)
      ctx.stroke()
    }
  }
}

// ─── 主波（簽章） ─────────────────────────────────────────────────────────
function waveAt(style, xn, phase, shapeMul = 1, freqMul = 1) {
  const primary = sin(xn * TWO_PI * style.frequency * freqMul + phase)
  const harmonic = sin(xn * TWO_PI * style.frequency * freqMul * 2.3 + phase * 1.7)
  const shp = style.shape * shapeMul
  return (1 - shp) * primary + shp * 0.6 * harmonic
}

function edgeTaper(xn) {
  return pow(sin(xn * Math.PI), 0.5)
}

function gradStrokeStyle(hue, xn, t, sp, alpha) {
  const g = 0.5 + 0.5 * sin(xn * TWO_PI * 1.3 - t * 1.4)
  const whiteness = pow(g, 2) * ORB_CONFIG.whitePeak
  return hsbToRgba(hue, 85 * (1 - whiteness), lerp(55, 97, g) + 10 * sp, alpha)
}

function drawMainWave(ctx, styleKey, hue, cx, cy, R, t, sp, env) {
  const style = ORB_STYLES[styleKey] || ORB_STYLES.O
  const w = R * 2
  const x0 = cx - R
  const amp = R * ORB_CONFIG.mainWaveAmp * (1 + sp * 0.8) * env
  const phase = t * (0.9 + sp * 1.2) + hue * 0.01
  const n = 80

  const drawWaveLine = (shapeMul, freqMul, phOff, weight, alphaMul, yOff = 0) => {
    let prev = null
    for (let i = 0; i <= n; i += 1) {
      const xn = i / n
      const v = waveAt(style, xn, phase + phOff, shapeMul, freqMul)
      const x = x0 + xn * w
      const y = cy + yOff * edgeTaper(xn) + v * amp * edgeTaper(xn)
      if (prev) {
        ctx.strokeStyle = gradStrokeStyle(hue, xn, t, sp, 88 * alphaMul)
        ctx.lineWidth = weight
        ctx.beginPath()
        ctx.moveTo(prev[0], prev[1])
        ctx.lineTo(x, y)
        ctx.stroke()
      }
      prev = [x, y]
    }
  }

  switch (styleKey) {
    case 'E': {
      drawWaveLine(1, 1, 0, 2.2, 1)
      // 星芒
      for (let k = 0; k < 4; k += 1) {
        const u = (k + 0.5) / 4
        const tw = pow(0.5 + 0.5 * sin(t * 2.2 + k * 1.9), 2.4)
        if (tw < 0.08) continue
        const v = waveAt(style, u, phase)
        const sx = x0 + u * w
        const sy = cy + v * amp * edgeTaper(u)
        const ln = 3 + 6 * tw
        ctx.strokeStyle = hsbToRgba(hue, 35, 98, 82 * tw)
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.moveTo(sx - ln, sy)
        ctx.lineTo(sx + ln, sy)
        ctx.moveTo(sx, sy - ln)
        ctx.lineTo(sx, sy + ln)
        ctx.stroke()
      }
      break
    }
    case 'A':
      drawWaveLine(0.6, 1, 0, 2.2, 1)
      drawWaveLine(0.6, 1, Math.PI, 1.8, 0.8)
      break
    case 'C':
      drawWaveLine(0.4, 1, 0, 2.2, 1)
      drawWaveLine(0.4, 1, 0, 1, 0.4, -amp * 0.55)
      drawWaveLine(0.4, 1, 0, 1, 0.4, amp * 0.55)
      break
    case 'N': {
      const steps = 30
      let prev = null
      for (let i = 0; i <= steps; i += 1) {
        const xn = i / steps
        let v = waveAt(style, xn, phase)
        const nz = noise(xn * 9, t * 1.3 + 50)
        if (nz > 0.72) v += (nz - 0.72) * 8 * (i % 2 === 0 ? 1 : -1)
        const x = x0 + xn * w
        const y = cy + v * amp * edgeTaper(xn)
        if (prev) {
          ctx.strokeStyle = gradStrokeStyle(hue, xn, t, sp, 88)
          ctx.lineWidth = 2.2
          ctx.beginPath()
          ctx.moveTo(prev[0], prev[1])
          ctx.lineTo(x, y)
          ctx.stroke()
        }
        prev = [x, y]
      }
      break
    }
    case 'O':
    default:
      drawWaveLine(1, 1, 0, 2.2, 1)
      drawWaveLine(1, 1.6, 1.1, 1.2, 0.5)
      drawWaveLine(1, 0.5, 2.2, 1.2, 0.5)
      break
  }
}

/**
 * 畫一顆完整的 Line Orb。
 *
 * @param {CanvasRenderingContext2D} ctx（呼叫端負責 additive 混合模式）
 * @param {object} opts { styleKey, hue, cx, cy, R, t, sp, level, idx }
 *   sp：說話啟動度 0~1（平滑後）；level：真實播放能量 0~1（沒有時傳 null）
 */
export function drawOrb(ctx, { styleKey, hue, cx, cy, R, t, sp, level, idx }) {
  // 說話包絡：有真實能量訊號時用它（貼合實際語音），否則用合成包絡
  const rawEnv = level != null && level > 0.02 ? 0.55 + 0.45 * min(1, level * 1.6) : voiceEnvSynthetic(t, idx)
  const env = lerp(1, rawEnv, sp)

  drawCage(ctx, styleKey, hue, cx, cy, R * (1 + sp * 0.08), t, sp)
  drawCore(ctx, hue, cx, cy, R, t, sp, idx, env)
  drawMainWave(ctx, styleKey, hue, cx, cy, R, t, sp, env)
}

export { hsbToRgba }
