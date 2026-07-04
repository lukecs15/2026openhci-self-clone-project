/**
 * App.jsx - 應用程式根組件
 *
 * 路由結構：
 *   /             → DrawingPage（上傳/繪製圖像）
 *   /model        → ModelPage（3D 模型展示 + 人格問卷）
 *   /chat         → ChatPage（文字備用對話模式）
 *   /voice-setup  → VoiceSetupPage（聲音克隆設定）
 *   /scene        → ScenePage（多物件語音對話場景，主要入口）
 */

import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import DrawingPage from './pages/DrawingPage'
import ModelPage from './pages/ModelPage'
import ChatPage from './pages/ChatPage'
import VoiceSetupPage from './pages/VoiceSetupPage'
import ScenePage from './pages/ScenePage'
import useAppStore from './store/useAppStore'

function NavBar() {
  const modelUrl = useAppStore((s) => s.modelUrl)
  const personality = useAppStore((s) => s.personality)

  const navStyle = ({ isActive }) => ({
    padding: '0.5rem 1.25rem',
    borderRadius: '9999px',
    textDecoration: 'none',
    fontWeight: isActive ? 700 : 400,
    background: isActive ? '#6366f1' : 'transparent',
    color: isActive ? '#fff' : '#94a3b8',
    transition: 'all 0.2s',
    fontSize: '0.9rem',
  })

  const disabledStyle = {
    padding: '0.5rem 1.25rem',
    borderRadius: '9999px',
    textDecoration: 'none',
    fontWeight: 400,
    background: 'transparent',
    color: '#334155',
    cursor: 'not-allowed',
    fontSize: '0.9rem',
  }

  return (
    <nav style={{
      display: 'flex',
      gap: '0.25rem',
      padding: '0.75rem 2rem',
      background: '#0f172a',
      borderBottom: '1px solid #1e293b',
      alignItems: 'center',
    }}>
      <span style={{ color: '#6366f1', fontWeight: 800, fontSize: '1.125rem', marginRight: 'auto' }}>
        ✦ 記憶之物
      </span>
      <NavLink to="/" style={navStyle} end>繪製</NavLink>
      <NavLink
        to="/model"
        style={modelUrl ? navStyle : () => disabledStyle}
        onClick={(e) => !modelUrl && e.preventDefault()}
        title={!modelUrl ? '請先生成 3D 模型' : ''}
      >
        3D 模型
      </NavLink>

      {/* 主要入口：語音場景 */}
      <NavLink
        to="/scene"
        style={personality ? navStyle : () => disabledStyle}
        onClick={(e) => !personality && e.preventDefault()}
        title={!personality ? '請先完成人格問卷' : ''}
      >
        ✦ 語音場景
      </NavLink>

      {/* 聲音設定 */}
      <NavLink
        to="/voice-setup"
        style={personality ? navStyle : () => disabledStyle}
        onClick={(e) => !personality && e.preventDefault()}
        title={!personality ? '請先完成人格問卷' : ''}
      >
        聲音設定
      </NavLink>

      {/* 文字對話（備用） */}
      <NavLink
        to="/chat"
        style={personality ? navStyle : () => disabledStyle}
        onClick={(e) => !personality && e.preventDefault()}
        title={!personality ? '請先完成人格問卷' : '文字備用模式'}
      >
        文字對話
      </NavLink>
    </nav>
  )
}

function ErrorBanner() {
  const error = useAppStore((s) => s.error)
  const clearError = useAppStore((s) => s.clearError)

  if (!error) return null
  return (
    <div style={{
      background: '#7f1d1d',
      color: '#fca5a5',
      padding: '0.75rem 2rem',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      fontSize: '0.875rem',
    }}>
      <span>⚠ {error}</span>
      <button
        onClick={clearError}
        style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: '1.125rem' }}
      >
        ×
      </button>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' }}>
        <NavBar />
        <ErrorBanner />
        <Routes>
          {/* 語音場景：全螢幕，不套用 maxWidth padding */}
          <Route path="/scene" element={<ScenePage />} />

          {/* 其他頁面：套用標準 container */}
          <Route path="/*" element={
            <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem 1rem' }}>
              <Routes>
                <Route path="/" element={<DrawingPage />} />
                <Route path="/model" element={<ModelPage />} />
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/voice-setup" element={<VoiceSetupPage />} />
              </Routes>
            </main>
          } />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
