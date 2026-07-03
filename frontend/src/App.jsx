/**
 * App.jsx - 應用程式根組件
 *
 * 路由結構：
 *   /          → DrawingPage（上傳/繪製圖像）
 *   /model     → ModelPage（3D 模型展示 + 人格問卷）
 *   /chat      → ChatPage（與物品對話）
 */

import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import DrawingPage from './pages/DrawingPage'
import ModelPage from './pages/ModelPage'
import ChatPage from './pages/ChatPage'
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
  })

  return (
    <nav style={{
      display: 'flex',
      gap: '0.5rem',
      padding: '1rem 2rem',
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
        style={navStyle}
        onClick={(e) => !modelUrl && e.preventDefault()}
        title={!modelUrl ? '請先生成 3D 模型' : ''}
      >
        3D 模型
      </NavLink>
      <NavLink
        to="/chat"
        style={navStyle}
        onClick={(e) => !personality && e.preventDefault()}
        title={!personality ? '請先完成人格問卷' : ''}
      >
        對話
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
        <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem 1rem' }}>
          <Routes>
            <Route path="/" element={<DrawingPage />} />
            <Route path="/model" element={<ModelPage />} />
            <Route path="/chat" element={<ChatPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
