/**
 * client.js - Axios API 客戶端
 *
 * 統一管理後端 API 請求，包含：
 * - Base URL 設定
 * - 錯誤攔截器（統一格式化錯誤訊息）
 * - 各端點的封裝函式
 */

import axios from 'axios'

// ── Base 設定 ─────────────────────────────────
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 300_000, // 5 分鐘（3D 生成可能需要較長時間）
  headers: { 'Content-Type': 'application/json' },
})

// 回應錯誤攔截器
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const detail =
      error.response?.data?.detail ||
      error.message ||
      '未知錯誤，請稍後再試'
    return Promise.reject(new Error(detail))
  }
)


// ── Image-to-3D ──────────────────────────────

/**
 * 上傳圖像並等待 3D 模型生成完成。
 *
 * @param {Blob|File} imageBlob - 圖像 Blob 或 File 物件
 * @param {string} [filename='drawing.png'] - 檔案名稱
 * @returns {Promise<{task_id, status, model_url, thumbnail_url, progress}>}
 */
export async function generateModel(imageBlob, filename = 'drawing.png') {
  const formData = new FormData()
  formData.append('file', imageBlob, filename)

  const response = await api.post('/generate-3d', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return response.data
}

/**
 * 查詢 3D 任務狀態（用於手動輪詢）。
 *
 * @param {string} taskId - Meshy.ai 任務 ID
 * @returns {Promise<{task_id, status, model_url, thumbnail_url, progress}>}
 */
export async function getTaskStatus(taskId) {
  const response = await api.get(`/task/${taskId}`)
  return response.data
}


// ── Personality ───────────────────────────────

/**
 * 發送人格問卷並取得分析結果。
 *
 * @param {object} payload - { big_five: BigFiveAnswers, object_description, self_description }
 * @returns {Promise<PersonalityAnalyzeResponse>}
 */
export async function analyzePersonality(payload) {
  const response = await api.post('/personality/analyze', payload)
  return response.data
}


// ── Chat ──────────────────────────────────────

/**
 * 發送對話訊息並取得物品的回應。
 *
 * @param {object} payload - { message, session_id, personality? }
 * @returns {Promise<{reply, session_id, history}>}
 */
export async function sendChat(payload) {
  const response = await api.post('/chat', payload)
  return response.data
}

/**
 * 取得指定 session 的對話歷史。
 *
 * @param {string} sessionId - Session ID
 * @returns {Promise<Array<{role, content}>>}
 */
export async function getChatHistory(sessionId) {
  const response = await api.get(`/chat/${sessionId}/history`)
  return response.data
}

/**
 * 清除指定 session 的對話歷史。
 *
 * @param {string} sessionId - Session ID
 * @returns {Promise<{message}>}
 */
export async function clearChatSession(sessionId) {
  const response = await api.delete(`/chat/${sessionId}`)
  return response.data
}

export default api
