/**
 * onboardingClient.js — final web 與後端 onboarding REST 端點的溝通
 *
 * 對應 voice_clone_backend/routers/onboarding.py：
 *   GET  /api/onboarding-sessions/{id}          輪詢連結狀態（404=還沒掃碼上傳）
 *   POST /api/onboarding-sessions/{id}/result   體驗結束回寫三情境聚合報告
 * 與 routers/qr.py：
 *   GET  /api/qr?data=...&size=...              QR PNG（直接當 <img src> 用）
 */

// VITE_API_BASE_URL 留空＝走同源相對路徑 /api，由 vite dev server 的 proxy
// 轉發到後端（見 vite.config.js「cloudflared 部署」說明）——tunnel 部署時
// 只需要一條 tunnel 指到 dev server，沒有 CORS / mixed content 問題。
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'
const MOBILE_BASE_URL = import.meta.env.VITE_MOBILE_BASE_URL || 'http://localhost:5173'

class FinalWebApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'FinalWebApiError'
    this.status = status
  }
}

async function readErrorDetail(res) {
  try {
    const body = await res.json()
    return body.detail || JSON.stringify(body)
  } catch {
    return res.statusText
  }
}

/** 404（還沒連結）回 null，讓輪詢端不用把「正常的等待」當例外處理。 */
export async function getOnboardingSession(sessionId) {
  const res = await fetch(`${API_BASE_URL}/onboarding-sessions/${sessionId}`)
  if (res.status === 404) return null
  if (!res.ok) throw new FinalWebApiError(await readErrorDetail(res), res.status)
  return res.json()
}

/** 體驗結束：回寫 OnboardingResult（含三情境 scenarios 聚合，見後端 schemas.py）。 */
export async function postOnboardingResult(sessionId, resultPayload) {
  const res = await fetch(`${API_BASE_URL}/onboarding-sessions/${sessionId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resultPayload),
  })
  if (!res.ok) throw new FinalWebApiError(await readErrorDetail(res), res.status)
  return res.json()
}

/** 後端產生 QR PNG 的圖片網址（直接給 <img src> 使用）。 */
export function qrImageUrl(data, size = 480) {
  return `${API_BASE_URL}/qr?data=${encodeURIComponent(data)}&size=${size}`
}

/** 手機端「上傳問卷+聲音」連結頁網址（QR 內容）。 */
export function mobileLinkUrl(sessionId) {
  return `${MOBILE_BASE_URL}/link?session=${sessionId}`
}

/** 手機端「領取體驗報告」結果頁網址（QR 內容）。 */
export function mobileResultUrl(sessionId) {
  return `${MOBILE_BASE_URL}/result?session=${sessionId}`
}

export { FinalWebApiError }
