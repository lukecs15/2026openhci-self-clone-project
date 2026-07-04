/**
 * ScenePage.jsx — 語音對話場景頁面（路由：/scene）
 *
 * 這是主要的語音對話入口頁面，包裝 VoiceScene 元件，
 * 並從 Zustand store 取得場景所需的物件資料。
 *
 * 若 voiceSession.objects 為空，引導用戶先完成人格設定。
 *
 * TODO: 加入場景結束後的回顧頁面（顯示對話摘要）
 * TODO: 加入分享功能（對話記錄導出）
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import VoiceScene from '../components/VoiceScene'
import useAppStore from '../store/useAppStore'

export default function ScenePage() {
  const navigate = useNavigate()
  const voiceSession = useAppStore(s => s.voiceSession)
  const personality = useAppStore(s => s.personality)
  const modelUrl = useAppStore(s => s.modelUrl)
  const setVoiceObjects = useAppStore(s => s.setVoiceObjects)

  // 若 store 中無物件，且有模型 + 人格，自動建立預設物件並存入 store
  useEffect(() => {
    if (voiceSession.objects.length === 0 && modelUrl && personality) {
      setVoiceObjects([{
        object_id: `obj-default-${Date.now()}`,
        object_name: personality.object_description?.slice(0, 20) || '記憶之物',
        object_description: personality.object_description || '',
        model_url: modelUrl,
        personality: personality,
      }])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const objects = voiceSession.objects

  if (objects.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        color: '#64748b',
        gap: '1rem',
      }}>
        <div style={{ fontSize: '3rem' }}>✦</div>
        <p style={{ fontSize: '1rem' }}>請先完成 3D 模型生成與人格設定。</p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={() => navigate('/')}
            style={{
              padding: '0.6rem 1.5rem',
              background: 'transparent',
              border: '1px solid rgba(99, 102, 241, 0.4)',
              borderRadius: '8px',
              color: '#6366f1',
              cursor: 'pointer',
            }}
          >
            繪製圖像
          </button>
          <button
            onClick={() => navigate('/model')}
            style={{
              padding: '0.6rem 1.5rem',
              background: '#6366f1',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            3D 模型設定
          </button>
        </div>
      </div>
    )
  }

  return (
    <VoiceScene
      objects={objects}
      sessionId={voiceSession.sessionId}
      initialSceneMode={voiceSession.sceneMode}
    />
  )
}
