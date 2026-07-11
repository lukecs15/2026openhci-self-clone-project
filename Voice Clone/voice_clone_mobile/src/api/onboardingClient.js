/**
 * onboardingClient.js — 與 voice_clone_backend 的 onboarding REST 端點溝通
 *
 * 對應 voice_clone_backend/routers/onboarding.py：
 *   POST /api/onboarding-sessions/{session_id}/link      上傳問卷+聲音樣本
 *   GET  /api/onboarding-sessions/{session_id}            查詢連結狀態
 *   GET  /api/onboarding-sessions/{session_id}/result      取回結束結果（總結+融合波形）
 *
 * 這裡刻意不用 try/catch 吞掉錯誤，統一用「拋出帶有 status 的 Error」的方式，
 * 讓呼叫端（頁面元件）可以依 status 顯示不同訊息（例如 409 代表「已經連結
 * 過」、404 代表「找不到這場對話」），跟桌機端 api/voiceAgentClient.js 的
 * 錯誤處理風格一致。
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8200/api'

class OnboardingApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'OnboardingApiError'
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

/**
 * 上傳 Big Five 分數 + 聲音樣本，建立 5 位「自我」agent。
 *
 * @param {string} sessionId
 * @param {Record<string, number>} bigFiveScores 五個向度 0~100 的分數
 * @param {Blob} audioBlob 錄好的聲音樣本
 * @param {string} [label] 聲音克隆 profile 顯示名稱
 * @returns {Promise<object>} 後端回傳的 OnboardingSession（含 agents）
 */
export async function linkOnboardingSession(sessionId, bigFiveScores, audioBlob, label = '我的聲音') {
  const form = new FormData()
  form.append('big_five', JSON.stringify(bigFiveScores))
  form.append('label', label)
  form.append('file', audioBlob, 'sample.webm')

  const res = await fetch(`${API_BASE_URL}/onboarding-sessions/${sessionId}/link`, {
    method: 'POST',
    body: form,
  })

  if (!res.ok) {
    throw new OnboardingApiError(await readErrorDetail(res), res.status)
  }
  return res.json()
}

/**
 * 查詢連結狀態（連結成功前，主系統/手機都可能拿這個確認狀態）。
 * @returns {Promise<object|null>} 找不到（尚未連結）回傳 null，不當例外處理
 */
export async function getOnboardingSession(sessionId) {
  const res = await fetch(`${API_BASE_URL}/onboarding-sessions/${sessionId}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new OnboardingApiError(await readErrorDetail(res), res.status)
  }
  return res.json()
}

/**
 * 取回體驗結束後的結果（總結句子 + 融合波形 + 參與過的 agent 簡要資訊）。
 * 體驗還沒結束時後端會回 409，這裡轉成 `status: 'pending'` 的回傳值而不是
 * 拋例外，方便呼叫端寫輪詢邏輯時不用特別 try/catch 這個「正常的等待狀態」。
 *
 * @returns {Promise<{status: 'ready', result: object} | {status: 'pending'} | {status: 'not_found'}>}
 */
export async function getOnboardingResult(sessionId) {
  const res = await fetch(`${API_BASE_URL}/onboarding-sessions/${sessionId}/result`)
  if (res.status === 404) return { status: 'not_found' }
  if (res.status === 409) return { status: 'pending' }
  if (!res.ok) {
    throw new OnboardingApiError(await readErrorDetail(res), res.status)
  }
  const result = await res.json()
  return { status: 'ready', result }
}

export { OnboardingApiError }
