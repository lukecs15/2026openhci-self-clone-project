/**
 * ChatPage.jsx - 第三頁：與物品（自我延伸）對話
 *
 * 佈局：
 * - 左側：3D 模型縮覽（或縮圖）
 * - 右側：ChatInterface 對話 UI
 * - 底部：Session 管理（清除歷史、新對話）
 */

import { useNavigate } from 'react-router-dom'
import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, useGLTF, Environment, Center } from '@react-three/drei'
import ChatInterface from '../components/ChatInterface'
import useAppStore from '../store/useAppStore'
import { clearChatSession } from '../api/client'

// 小型 3D 預覽（側邊欄用）
function MiniModel({ url }) {
  const { scene } = useGLTF(url)
  return <Center><primitive object={scene} /></Center>
}

function MiniModelViewer({ modelUrl, thumbnailUrl }) {
  if (modelUrl) {
    return (
      <div style={{ width: '100%', height: '220px', borderRadius: '8px', overflow: 'hidden', background: '#0a0f1e' }}>
        <Canvas camera={{ position: [0, 1, 3], fov: 50 }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[3, 5, 3]} intensity={1} />
          <Environment preset="city" />
          <Suspense fallback={null}>
            <MiniModel url={modelUrl} />
          </Suspense>
          <OrbitControls enableDamping autoRotate autoRotateSpeed={1.5} enableZoom={false} />
        </Canvas>
      </div>
    )
  }

  if (thumbnailUrl) {
    return (
      <img
        src={thumbnailUrl}
        alt="物品縮圖"
        style={{ width: '100%', borderRadius: '8px', objectFit: 'cover' }}
      />
    )
  }

  return (
    <div style={{
      height: '120px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#1e293b',
      borderRadius: '8px',
      fontSize: '2.5rem',
    }}>
      ✦
    </div>
  )
}

export default function ChatPage() {
  const navigate = useNavigate()
  const modelUrl = useAppStore((s) => s.modelUrl)
  const thumbnailUrl = useAppStore((s) => s.thumbnailUrl)
  const personality = useAppStore((s) => s.personality)
  const sessionId = useAppStore((s) => s.sessionId)
  const newSession = useAppStore((s) => s.newSession)
  const setError = useAppStore((s) => s.setError)

  if (!personality) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem', color: '#475569' }}>
        <p style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
          請先完成人格問卷，賦予物品它的靈魂。
        </p>
        <button
          onClick={() => navigate('/model')}
          style={{
            padding: '0.75rem 1.5rem',
            background: '#6366f1',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          前往 3D 模型頁
        </button>
      </div>
    )
  }

  const handleNewSession = async () => {
    try {
      await clearChatSession(sessionId)
    } catch (_) {
      // 忽略清除錯誤
    }
    newSession()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 800, color: '#e2e8f0', marginBottom: '0.5rem' }}>
          與你的記憶對話
        </h1>
        <p style={{ color: '#64748b', fontSize: '0.9rem' }}>
          它體現了你的一部分。傾聽它說話。
        </p>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr',
        gap: '1.5rem',
        alignItems: 'start',
      }}>
        {/* 左側：物品資訊 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <MiniModelViewer modelUrl={modelUrl} thumbnailUrl={thumbnailUrl} />

          <div style={{
            background: '#1e293b',
            borderRadius: '8px',
            padding: '1rem',
            border: '1px solid #334155',
          }}>
            <p style={{ color: '#64748b', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
              物品
            </p>
            <p style={{ color: '#e2e8f0', fontSize: '0.875rem', fontStyle: 'italic', lineHeight: 1.5 }}>
              {personality.object_description}
            </p>
          </div>

          <div style={{
            background: '#0f172a',
            borderRadius: '8px',
            padding: '1rem',
            border: '1px dashed #334155',
          }}>
            <p style={{ color: '#64748b', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
              Session
            </p>
            <p style={{ color: '#334155', fontSize: '0.7rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {sessionId.slice(0, 8)}...
            </p>
            <button
              onClick={handleNewSession}
              style={{
                marginTop: '0.5rem',
                width: '100%',
                padding: '0.4rem',
                background: '#1e293b',
                color: '#64748b',
                border: '1px solid #334155',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '0.75rem',
              }}
            >
              ↺ 新的對話
            </button>
          </div>
        </div>

        {/* 右側：對話 */}
        <ChatInterface thumbnailUrl={thumbnailUrl} />
      </div>
    </div>
  )
}
