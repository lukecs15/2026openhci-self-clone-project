/**
 * useAppStore.js - Zustand 全域狀態管理
 *
 * 管理的狀態：
 * - 使用者上傳的圖像（Blob）
 * - 生成的 3D 模型 URL 與任務狀態
 * - 人格分析結果
 * - 對話 session ID
 * - 全域 loading 與錯誤狀態
 */

import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'

const useAppStore = create((set, get) => ({
  // ── 圖像 ──────────────────────────────────────
  /** @type {Blob|null} 使用者繪製或上傳的圖像 */
  imageBlob: null,
  /** @type {string|null} 圖像的預覽 URL（Object URL） */
  imagePreviewUrl: null,

  setImage: (blob) => {
    // 清除舊的 Object URL 以避免記憶體洩漏
    const prev = get().imagePreviewUrl
    if (prev) URL.revokeObjectURL(prev)

    const previewUrl = blob ? URL.createObjectURL(blob) : null
    set({ imageBlob: blob, imagePreviewUrl: previewUrl })
  },

  // ── 3D 模型 ───────────────────────────────────
  /** @type {string|null} Meshy.ai 任務 ID */
  taskId: null,
  /** @type {'idle'|'pending'|'in_progress'|'succeeded'|'failed'} */
  modelStatus: 'idle',
  /** @type {string|null} GLB 模型 URL */
  modelUrl: null,
  /** @type {string|null} 模型縮圖 URL */
  thumbnailUrl: null,
  /** @type {number} 生成進度 0–100 */
  modelProgress: 0,

  setModelTask: (taskId) => set({ taskId, modelStatus: 'pending', modelProgress: 0 }),
  setModelResult: ({ status, model_url, thumbnail_url, progress, task_id }) =>
    set({
      taskId: task_id ?? get().taskId,
      modelStatus: status,
      modelUrl: model_url ?? null,
      thumbnailUrl: thumbnail_url ?? null,
      modelProgress: progress ?? 0,
    }),
  resetModel: () =>
    set({ taskId: null, modelStatus: 'idle', modelUrl: null, thumbnailUrl: null, modelProgress: 0 }),

  // ── 人格 ──────────────────────────────────────
  /** @type {object|null} PersonalityAnalyzeResponse */
  personality: null,

  setPersonality: (data) => set({ personality: data }),
  clearPersonality: () => set({ personality: null }),

  // ── 對話 Session ──────────────────────────────
  /** @type {string} 當前對話的 session ID */
  sessionId: uuidv4(),

  newSession: () => set({ sessionId: uuidv4() }),

  // ── 全域 UI 狀態 ──────────────────────────────
  /** @type {boolean} 全域載入中狀態 */
  isLoading: false,
  /** @type {string|null} 全域錯誤訊息 */
  error: null,

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),

  // ── 重置全部 ──────────────────────────────────
  resetAll: () => {
    const prev = get().imagePreviewUrl
    if (prev) URL.revokeObjectURL(prev)
    set({
      imageBlob: null,
      imagePreviewUrl: null,
      taskId: null,
      modelStatus: 'idle',
      modelUrl: null,
      thumbnailUrl: null,
      modelProgress: 0,
      personality: null,
      sessionId: uuidv4(),
      isLoading: false,
      error: null,
    })
  },
}))

export default useAppStore
