/**
 * App.jsx - 應用程式根組件
 *
 * 只有一個進入頁面：VoiceAgentsPage。一般多 Agent 對話／自我省思辯論的
 * 模式切換移到 VoiceAgentsPage 開始畫面裡的下拉選單（路由策略選單下方），
 * 不放在這個最上層（修過的 UX 調整：先前在這裡放了一條模式切換 bar，
 * 使用者希望改成畫面內的下拉選單，見 VoiceAgentsPage.jsx 檔案開頭說明）。
 *
 * pages/DebatePage.jsx 目前未被使用（辯論模式的進入流程已經併入
 * VoiceAgentsPage.jsx），先保留檔案內容以防之後需要參考，未來若確定不再
 * 需要可以整個移除。
 */

import VoiceAgentsPage from './pages/VoiceAgentsPage'

export default function App() {
  return <VoiceAgentsPage />
}
