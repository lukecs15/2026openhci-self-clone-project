/**
 * LineOrbs.jsx — 兩顆（或多顆）立場線條球的 canvas 容器
 *
 * 渲染邏輯全部在 utils/lineOrbRenderer.js（附件波形設計的移植）；這個元件
 * 只負責 canvas 生命週期、DPR 縮放、rAF 迴圈與「說話」狀態的平滑。
 *
 * 效能/同步設計：
 *   - orbs 的 speak 目標與能量透過 speakStateRef（ref 物件）每幀讀取，
 *     不走 React state——TTS chunk 播放中每幀都在變，用 state 會整棵樹重render
 *   - speak 的平滑沿用附件的 lerp(…, 0.08)，講完話會自然收回靜止呼吸
 *
 * @prop {Array} orbs [{ id, styleKey, hue, label }]（最多 5 顆，辯論用 2 顆）
 * @prop {object} speakStateRef ref，形如 { current: { activeId, level } }
 *   activeId：目前正在講話的 orb id（null=沒人講話）
 *   level：真實播放能量 0~1（useDebateSession.getSpeakLevel() 每幀取）
 * @prop {number} height canvas 高度（px）
 */

import { useEffect, useRef } from 'react'
import { ORB_CONFIG, ORB_STYLES, drawOrb, hsbToRgba } from '../utils/lineOrbRenderer'

export default function LineOrbs({ orbs, speakStateRef, height = 420 }) {
  const canvasRef = useRef(null)
  const orbsRef = useRef(orbs)
  orbsRef.current = orbs

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    let raf = 0
    let disposed = false
    const speaks = new Map() // orb.id -> 平滑後的 sp

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const t0 = performance.now()
    const frame = () => {
      if (disposed) return
      const t = (performance.now() - t0) / 1000
      const rect = canvas.getBoundingClientRect()
      const wCss = rect.width
      const hCss = rect.height
      const currentOrbs = orbsRef.current || []
      const speakState = speakStateRef?.current || {}

      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = ORB_CONFIG.bg
      ctx.fillRect(0, 0, wCss, hCss)

      const S = Math.min(wCss, hCss)
      const R = ORB_CONFIG.orbRadius * S
      const cy = hCss * 0.47
      const spacing = Math.min(wCss / Math.max(1, currentOrbs.length), R * 3.8)

      ctx.globalCompositeOperation = 'lighter' // 對齊 p5 blendMode(ADD)
      ctx.lineCap = 'round'

      currentOrbs.forEach((orb, i) => {
        const cx = wCss / 2 + (i - (currentOrbs.length - 1) / 2) * spacing
        const isActive = speakState.activeId === orb.id
        const target = isActive ? 1 : 0
        const prev = speaks.get(orb.id) ?? 0
        const sp = prev + (target - prev) * 0.08
        speaks.set(orb.id, sp)

        const style = ORB_STYLES[orb.styleKey] ? orb.styleKey : 'O'
        drawOrb(ctx, {
          styleKey: style,
          hue: orb.hue ?? ORB_STYLES[style].defaultHue,
          cx,
          cy,
          R,
          t,
          sp,
          level: isActive ? speakState.level ?? null : null,
          idx: i,
        })

        // 立場名稱標籤（說話時亮起）
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = hsbToRgba(orb.hue ?? 0, 45, 88, 45 + sp * 45)
        ctx.font = `${Math.max(13, R * 0.18)}px "Noto Serif TC", serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(orb.label || '', cx, cy + R * 1.35)
        if (orb.subLabel) {
          ctx.fillStyle = hsbToRgba(orb.hue ?? 0, 25, 70, 30 + sp * 30)
          ctx.font = `${Math.max(11, R * 0.12)}px sans-serif`
          ctx.fillText(orb.subLabel, cx, cy + R * 1.35 + Math.max(15, R * 0.22))
        }
        ctx.globalCompositeOperation = 'lighter'
      })

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [speakStateRef])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: `${height}px`, display: 'block' }}
      aria-label="立場克隆形象波形視覺"
    />
  )
}
