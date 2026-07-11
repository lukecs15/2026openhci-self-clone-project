/**
 * App.jsx — 應用程式根組件（極簡手動路由）
 *
 * 只有兩個真正需要獨立網址的頁面（QR code 會直接編碼這兩個路徑）：
 *   /link?session=<id>    問卷 + 錄音 + 上傳連結（見 pages/OnboardingFlow.jsx）
 *   /result?session=<id>  體驗結束後的紀念畫面（見 pages/ResultPage.jsx）
 *
 * 其餘路徑（含網站根目錄 `/`）一律視為 OnboardingFlow 的入口——這個流程
 * 內部的步驟（歡迎/問卷/錄音/上傳）本來就不需要各自獨立、可加書籤的網址，
 * 用 React state 管理就足夠，所以沒有引入額外的路由套件（跟桌機端
 * voice_clone_frontend 一貫的極簡依賴風格一致）。
 */

import OnboardingFlow from './pages/OnboardingFlow'
import ResultPage from './pages/ResultPage'

export default function App() {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'

  if (pathname.startsWith('/result')) {
    return <ResultPage />
  }

  return <OnboardingFlow />
}
