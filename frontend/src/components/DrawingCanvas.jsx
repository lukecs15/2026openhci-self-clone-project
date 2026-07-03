/**
 * DrawingCanvas.jsx - HTML5 Canvas 繪圖工具
 *
 * 功能：
 * - 畫筆（自由繪製）、橡皮擦
 * - 顏色選擇器、線條粗細調整
 * - 清空畫布
 * - 上傳已有圖片（覆蓋至畫布）
 * - 匯出為 PNG Blob（供上傳至後端）
 */

import { useRef, useState, useEffect, useCallback } from 'react'

const TOOLS = { PEN: 'pen', ERASER: 'eraser' }

const btnStyle = (active) => ({
  padding: '0.4rem 0.9rem',
  borderRadius: '6px',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: active ? 700 : 400,
  background: active ? '#6366f1' : '#1e293b',
  color: active ? '#fff' : '#94a3b8',
  transition: 'all 0.15s',
})

export default function DrawingCanvas({ onExport }) {
  const canvasRef = useRef(null)
  const [tool, setTool] = useState(TOOLS.PEN)
  const [color, setColor] = useState('#ffffff')
  const [lineWidth, setLineWidth] = useState(4)
  const [isDrawing, setIsDrawing] = useState(false)
  const lastPos = useRef(null)

  // 初始化畫布：黑色背景
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#1e293b'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }, [])

  /** 取得相對於 canvas 的座標 */
  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    return {
      x: (clientX - rect.left) * (canvasRef.current.width / rect.width),
      y: (clientY - rect.top) * (canvasRef.current.height / rect.height),
    }
  }

  const startDrawing = useCallback((e) => {
    e.preventDefault()
    setIsDrawing(true)
    lastPos.current = getPos(e)
  }, [])

  const draw = useCallback((e) => {
    if (!isDrawing) return
    e.preventDefault()
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const pos = getPos(e)

    ctx.lineWidth = tool === TOOLS.ERASER ? lineWidth * 4 : lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = tool === TOOLS.ERASER ? '#1e293b' : color
    ctx.globalCompositeOperation = tool === TOOLS.ERASER ? 'destination-out' : 'source-over'

    ctx.beginPath()
    ctx.moveTo(lastPos.current.x, lastPos.current.y)
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
    lastPos.current = pos
  }, [isDrawing, tool, color, lineWidth])

  const stopDrawing = useCallback(() => {
    setIsDrawing(false)
    lastPos.current = null
  }, [])

  /** 清空畫布並重設為深色背景 */
  const clearCanvas = () => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#1e293b'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  /** 上傳圖片並繪製至畫布 */
  const handleUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')
      ctx.globalCompositeOperation = 'source-over'
      // 等比例縮放
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height)
      const w = img.width * scale
      const h = img.height * scale
      const x = (canvas.width - w) / 2
      const y = (canvas.height - h) / 2
      ctx.fillStyle = '#1e293b'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, x, y, w, h)
      URL.revokeObjectURL(url)
    }
    img.src = url
    e.target.value = '' // 允許重複上傳同一檔案
  }

  /** 匯出為 PNG Blob 並呼叫父組件的 onExport callback */
  const handleExport = () => {
    const canvas = canvasRef.current
    canvas.toBlob((blob) => {
      if (blob && onExport) onExport(blob)
    }, 'image/png')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* 工具列 */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btnStyle(tool === TOOLS.PEN)} onClick={() => setTool(TOOLS.PEN)}>
          ✏️ 畫筆
        </button>
        <button style={btnStyle(tool === TOOLS.ERASER)} onClick={() => setTool(TOOLS.ERASER)}>
          🧹 橡皮擦
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.8rem' }}>
          顏色
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            style={{ width: '2rem', height: '2rem', border: 'none', cursor: 'pointer', borderRadius: '4px' }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.8rem' }}>
          粗細 {lineWidth}px
          <input
            type="range"
            min={1} max={40}
            value={lineWidth}
            onChange={(e) => setLineWidth(Number(e.target.value))}
            style={{ width: '80px' }}
          />
        </label>

        <button style={btnStyle(false)} onClick={clearCanvas}>🗑 清空</button>

        <label style={{ ...btnStyle(false), cursor: 'pointer' }}>
          📁 上傳圖片
          <input type="file" accept="image/*" onChange={handleUpload} style={{ display: 'none' }} />
        </label>
      </div>

      {/* 畫布 */}
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        style={{
          border: '2px solid #334155',
          borderRadius: '8px',
          cursor: tool === TOOLS.ERASER ? 'cell' : 'crosshair',
          touchAction: 'none',
          width: '100%',
          maxWidth: '800px',
          display: 'block',
        }}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        onTouchStart={startDrawing}
        onTouchMove={draw}
        onTouchEnd={stopDrawing}
      />

      {/* 匯出按鈕 */}
      <button
        onClick={handleExport}
        style={{
          padding: '0.75rem 2rem',
          background: '#6366f1',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          fontSize: '1rem',
          fontWeight: 700,
          cursor: 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        ✦ 使用此圖像
      </button>
    </div>
  )
}
