/**
 * App.jsx - 應用程式根組件
 *
 * 本模組目前只有一個頁面：多 Agent 語音對話展示（VoiceAgentsPage）。
 * 之後若要擴充（例如 Agent 設定頁、聲音克隆上傳頁），可比照
 * ../frontend（Drawing to 3D 專案）的 react-router 結構加入路由。
 */

import VoiceAgentsPage from './pages/VoiceAgentsPage'

export default function App() {
  return <VoiceAgentsPage />
}
