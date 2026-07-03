/**
 * DrawingPage.jsx - 第一頁：繪製或上傳圖像
 *
 * 流程：
 * 1. 使用者在 DrawingCanvas 繪製或上傳圖片
 * 2. 點「使用此圖像」→ 圖像存入 Zustand Store
 * 3. 點「生成 3D 模型」→ 呼叫後端 /api/generate-3d，完成後導向 /model
 */

import { useNavigate } from 'react-router-dom'
import DrawingCanvas from '../components/DrawingCanvas'
import useAppStore from '../store/useAppStore'
import { generateModel } from '../api/client'

export default function DrawingPage() {
  const navigate = useNavigate()
  const imageBlob = useAppStore((s) => s.imageBlob)
  const imagePreviewUrl = useAppStore((s) => s.imagePreviewUrl)
  const setImage = useAppStore((s) => s.setImage)
  const setModelResult = useAppStore((s) => s.setModelResult)
  const setLoading = useAppStore((s) => s.setLoading)
  const setError = useAppStore((s) => s.setError)
  const isLoading = useAppStore((s) => s.isLoading)

  const handleExport = (blob) => {
    setImage(blob)
  }

  const handleGenerate = async () => {
    if (!imageBlob) {
      setError('請先繪製或上傳圖像。')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await generateModel(imageBlob, 'drawing.png')
      setModelResult(result)
      navigate('/model')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* 頁首說明 */}
      <div>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 800, color: '#e2e8f0', marginBottom: '0.5rem' }}>
          繪製你的記憶之物
        </h1>
        <p style={{ color: '#64748b', fontSize: '0.9rem', maxWidth: '520px' }}>
          畫下一個對你有意義的物品，或上傳一張圖片。
          它將化為 3D 形體，成為你的傾訴對象。
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2rem', alignItems: 'start' }}>
        {/* 畫布區 */}
        <DrawingCanvas onExport={handleExport} />

        {/* 右側：預覽 + 動作 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minWidth: '200px' }}>
          <div style={{
            background: '#1e293b',
            borderRadius: '8px',
            padding: '1rem',
            border: '1px solid #334155',
          }}>
            <p style={{ color: '#64748b', fontSize: '0.75rem', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              已選擇的圖像
            </p>
            {imagePreviewUrl ? (
              <img
                src={imagePreviewUrl}
                alt="預覽"
                style={{
                  width: '100%',
                  borderRadius: '4px',
                  border: '1px solid #334155',
                }}
              />
            ) : (
              <div style={{
                height: '100px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#334155',
                fontSize: '2rem',
              }}>
                🖼
              </div>
            )}
          </div>

          <button
            onClick={handleGenerate}
            disabled={!imageBlob || isLoading}
            style={{
              padding: '0.875rem',
              background: (!imageBlob || isLoading) ? '#334155' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.9rem',
              fontWeight: 700,
              cursor: (!imageBlob || isLoading) ? 'not-allowed' : 'pointer',
              transition: 'opacity 0.2s',
            }}
          >
            {isLoading ? '生成中...' : '✦ 生成 3D 模型'}
          </button>

          {isLoading && (
            <p style={{ color: '#64748b', fontSize: '0.75rem', textAlign: 'center' }}>
              Meshy.ai 正在處理<br />約需 1–3 分鐘
            </p>
          )}

          <div style={{
            background: '#0f172a',
            borderRadius: '8px',
            padding: '0.875rem',
            border: '1px dashed #334155',
          }}>
            <p style={{ color: '#475569', fontSize: '0.75rem', lineHeight: 1.6 }}>
              💡 <strong style={{ color: '#64748b' }}>提示</strong><br />
              線條清晰、對比明顯的圖像效果最佳。
              建議物品輪廓單純，背景保持深色。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
