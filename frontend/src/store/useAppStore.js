/**
 * useAppStore.js - Zustand 全域狀態管理
 *
 * 管理的狀態：
 * - 使用者上傳的圖像（Blob）
 * - 生成的 3D 模型 URL 與任務狀態
 * - 人格分析結果
 * - 對話 session ID
 * - 語音對話場景狀態（voiceSession）
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

  // ── 語音對話場景 ──────────────────────────────
  /**
   * voiceSession — 語音場景的完整狀態
   *
   * objects: 場景中的物件列表
   *   每個物件：{ object_id, object_name, object_description, model_url, personality }
   *   status: 'idle' | 'talking' | 'listening'（由 VoiceScene 管理，不存 store）
   *
   * voiceProfiles: { [objectId]: VoiceProfile }（後端建立後由前端快取）
   */
  voiceSession: {
    sessionId: uuidv4(),
    objects: [],              // ObjectPersona[]
    sceneMode: 'spatial',     // 'spatial' | 'abstract'
    exchangeCount: 0,
    canEnd: false,
    isUserSpeaking: false,
    voiceProfiles: {},        // { objectId: VoiceProfile }
  },

  /** 設定語音場景物件列表（覆蓋整個 objects 陣列） */
  setVoiceObjects: (objects) =>
    set((state) => ({
      voiceSession: { ...state.voiceSession, objects },
    })),

  /** 新增單一物件到場景 */
  addVoiceObject: (object) =>
    set((state) => ({
      voiceSession: {
        ...state.voiceSession,
        objects: [...state.voiceSession.objects, object],
      },
    })),

  /** 儲存 VoiceProfile（後端 clone 後回傳） */
  setVoiceProfile: (objectId, profile) =>
    set((state) => ({
      voiceSession: {
        ...state.voiceSession,
        voiceProfiles: { ...state.voiceSession.voiceProfiles, [objectId]: profile },
      },
    })),

  /** 切換場景模式 */
  setSceneMode: (sceneMode) =>
    set((state) => ({
      voiceSession: { ...state.voiceSession, sceneMode },
    })),

  /** 更新 voiceSession 的任意欄位（by WebSocket 回傳資料） */
  setVoiceSession: (updates) =>
    set((state) => ({
      voiceSession: { ...state.voiceSession, ...updates },
    })),

  /** 開始新的語音 session（重置計數器） */
  newVoiceSession: () =>
    set((state) => ({
      voiceSession: {
        ...state.voiceSession,
        sessionId: uuidv4(),
        exchangeCount: 0,
        canEnd: false,
        isUserSpeaking: false,
      },
    })),

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
      voiceSession: {
        sessionId: uuidv4(),
        objects: [],
        sceneMode: 'spatial',
        exchangeCount: 0,
        canEnd: false,
        isUserSpeaking: false,
        voiceProfiles: {},
      },
    })
  },
}))

export default useAppStore
