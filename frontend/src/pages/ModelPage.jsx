/**
 * ModelPage.jsx - 第二頁：3D 模型展示 + 人格問卷
 *
 * 佈局：
 * - 左側：ModelViewer（3D 模型）
 * - 右側：PersonalityForm（人格問卷）
 * 完成問卷後顯示「開始對話」按鈕，導向 /chat
 */

import { useNavigate } from 'react-router-dom'
import ModelViewer from '../components/ModelViewer'
import PersonalityForm from '../components/PersonalityForm'
import useAppStore from '../store/useAppStore'

export default function ModelPage() {
  const navigate = useNavigate()
  const modelUrl = useAppStore((s) => s.modelUrl)
  const modelStatus = useAppStore((s) => s.modelStatus)
  const modelProgress = useAppStore((s) => s.modelProgress)
  const thumbnailUrl = useAppStore((s) => s.thumbnailUrl)
  const personality = useAppStore((s) => s.personality)

  if (modelStatus === 'idle') {
    return (
      <div style={{ textAlign: 'center', padding: '4rem', color: '#475569' }}>
        <p style={{ fontSize: '1.25rem' }}>請先至「繪製」頁面上傳圖像並生成 3D 模型。</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 800, color: '#e2e8f0', marginBottom: '0.5rem' }}>
          你的記憶之物
        </h1>
        <p style={{ color: '#64748b', fontSize: '0.9rem' }}>
          {modelStatus === 'succeeded'
            ? '3D 模型已生成完成。完成下方問卷，賦予它你的人格。'
            : '正在將你的畫作化為立體形體...'}
        </p>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 380px',
        gap: '2rem',
        alignItems: 'start',
      }}>
        {/* 左側：3D 模型 */}
        <ModelViewer
          modelUrl={modelUrl}
          status={modelStatus}
          progress={modelProgress}
        />

        {/* 右側：人格問卷 */}
        <div style={{
          background: '#0f172a',
          borderRadius: '12px',
          border: '1px solid #1e293b',
          padding: '1.5rem',
          maxHeight: '540px',
          overflowY: 'auto',
        }}>
          <h2 style={{ color: '#a5b4fc', fontSize: '1rem', fontWeight: 700, marginBottom: '1.25rem' }}>
            賦予物品你的人格
          </h2>

          {modelStatus !== 'succeeded' ? (
            <p style={{ color: '#475569', fontSize: '0.875rem' }}>
              等待 3D 模型生成完成後，即可填寫問卷...
            </p>
          ) : (
            <PersonalityForm
              onComplete={() => {
                // 問卷完成後可選擇是否自動導航
              }}
            />
          )}
        </div>
      </div>

      {/* 縮圖與操作按鈕列 */}
      {modelStatus === 'succeeded' && (
        <div style={{
          display: 'flex',
          gap: '1rem',
          alignItems: 'center',
          padding: '1rem',
          background: '#1e293b',
          borderRadius: '8px',
          border: '1px solid #334155',
        }}>
          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt="模型縮圖"
              style={{ width: 48, height: 48, borderRadius: '8px', objectFit: 'cover' }}
            />
          )}
          <div style={{ flex: 1 }}>
            <p style={{ color: '#e2e8f0', fontSize: '0.875rem', fontWeight: 600 }}>
              3D 模型已就緒
            </p>
            <p style={{ color: '#64748b', fontSize: '0.75rem' }}>
              {personality ? '人格問卷已完成，可以開始對話了。' : '完成右側問卷後即可開始對話。'}
            </p>
          </div>
          <button
            onClick={() => navigate('/chat')}
            disabled={!personality}
            style={{
              padding: '0.75rem 1.5rem',
              background: personality ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : '#334155',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontWeight: 700,
              cursor: personality ? 'pointer' : 'not-allowed',
              fontSize: '0.9rem',
              transition: 'opacity 0.2s',
            }}
          >
            ✦ 開始對話 →
          </button>
        </div>
      )}
    </div>
  )
}
