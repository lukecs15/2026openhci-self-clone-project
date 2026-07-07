/**
 * voiceAgentClient.js — 與 voice_clone_backend 溝通的輔助函式
 *
 * 目前對話本身走 WebSocket（見 useVoiceAgentSession.js），這裡放置
 * 「非即時」的 REST 輔助邏輯：組裝 init_session 訊息、預設示範 agent 設定，
 * 以及使用者聲音克隆 profile 的上傳/建立（對應後端 routers/voice_profiles.py）。
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8200/api'

/**
 * @typedef {Object} AgentConfig
 * @property {string} agent_id
 * @property {string} display_name
 * @property {string} persona_prompt
 * @property {string} [voice_profile_id]
 * @property {string} [role_tag]
 */

/** 3 個示範 Agent，對應架構文件「目標支援 3 個以上 Agent 同時參與對話」。 */
export const DEFAULT_DEMO_AGENTS = [
  {
    agent_id: 'agent-a',
    display_name: '小明',
    persona_prompt: '你是小明，說話直接、務實，習慣先給結論再解釋原因。',
    voice_profile_id: '',
    role_tag: '務實派',
  },
  {
    agent_id: 'agent-b',
    display_name: '小華',
    persona_prompt: '你是小華，說話溫和、善於同理，喜歡先確認對方感受。',
    voice_profile_id: '',
    role_tag: '同理派',
  },
  {
    agent_id: 'agent-c',
    display_name: '阿德',
    persona_prompt: '你是阿德，個性風趣，常用比喻和玩笑緩和氣氛。',
    voice_profile_id: '',
    role_tag: '幽默派',
  },
]

/**
 * 組裝 init_session 訊息（送給後端 WebSocket 的第一則訊息）。
 *
 * routingStrategy 不傳（undefined）時，這裡刻意不塞任何值進物件（而不是
 * 塞一個預設字串），這樣 JSON.stringify 送出去的訊息就完全沒有
 * routing_strategy 這個欄位，後端會用 .env 的 AGENT_ROUTING_STRATEGY 設定
 * 值決定要用哪個策略。曾經的 bug：這裡預設值寫死 'heuristic'，導致前端
 * 每次 init_session 都主動要求 heuristic，就算後端 .env 設成 llm_decision
 * 也永遠不會生效。
 *
 * @param {AgentConfig[]} agents
 * @param {'heuristic'|'llm_decision'} [routingStrategy] 不傳則交給後端決定
 */
export function buildInitSessionMessage(agents, routingStrategy) {
  const message = { type: 'init_session', agents }
  if (routingStrategy) {
    message.routing_strategy = routingStrategy
  }
  return message
}

export function buildUserTextMessage(text) {
  return { type: 'user_text', text }
}

export function buildUserAudioMessage(base64Audio) {
  return { type: 'user_audio', audio: base64Audio }
}

export function buildEndSessionMessage() {
  return { type: 'end_session' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 使用者聲音克隆 Profile（REST，對應 routers/voice_profiles.py）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 上傳錄音/音訊檔，回傳暫存檔名（供 cloneVoiceProfile 使用）。
 * @param {Blob} audioBlob
 * @returns {Promise<{sample_filename: string, size_bytes: number}>}
 */
export async function uploadVoiceSample(audioBlob) {
  const form = new FormData()
  form.append('file', audioBlob, 'sample.webm')

  const res = await fetch(`${API_BASE_URL}/voice-profiles/upload-sample`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`上傳聲音樣本失敗（${res.status}）：${detail}`)
  }
  return res.json()
}

/**
 * 依已上傳的樣本建立聲音克隆 profile（後端會自動用 STT 轉錄逐字稿）。
 * @param {string} sampleFilename
 * @param {string} label
 * @returns {Promise<{profile_id: string, label: string, reference_text: string}>}
 */
export async function cloneVoiceProfile(sampleFilename, label = '我的聲音') {
  const res = await fetch(`${API_BASE_URL}/voice-profiles/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sample_filename: sampleFilename, label }),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`建立聲音克隆 profile 失敗（${res.status}）：${detail}`)
  }
  return res.json()
}

/** 上傳 + 建立 profile 的合併輔助函式，UI 通常直接呼叫這個就好。 */
export async function cloneVoiceFromRecording(audioBlob, label = '我的聲音') {
  const { sample_filename: sampleFilename } = await uploadVoiceSample(audioBlob)
  return cloneVoiceProfile(sampleFilename, label)
}

export async function listVoiceProfiles() {
  const res = await fetch(`${API_BASE_URL}/voice-profiles`)
  if (!res.ok) throw new Error(`取得聲音克隆 profile 列表失敗（${res.status}）`)
  return res.json()
}
