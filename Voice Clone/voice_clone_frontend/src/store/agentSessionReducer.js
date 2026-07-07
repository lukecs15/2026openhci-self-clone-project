/**
 * agentSessionReducer.js — 多 Agent 對話狀態機（純函式，方便單元測試）
 *
 * 把 WebSocket 收到的 server 訊息（見 voice_clone_backend/models/schemas.py
 * 的 ServerMessage）轉換成 UI 狀態：
 *   - agents            ：目前 session 的所有 agent 設定
 *   - activeSpeakerIds   ：目前正在發話的 agent id 列表（可能同時多個，job_group 情境）
 *   - routingMode        ：最近一次路由決策（'handoff' | 'job_group' | null）
 *   - pendingAgentIds     ：最近一次路由決策指定的目標 agent id 列表
 *   - transcript         ：對話紀錄（使用者發言 + 各 agent 發言，依收到順序）
 *   - status             ：'idle' | 'connecting' | 'ready' | 'error'
 *   - lastError          ：最後一次錯誤訊息
 *
 * 刻意把這個 reducer 抽成與 React 無關的純函式（不依賴 useReducer 以外的東西），
 * 才能在 vitest 裡直接測試狀態轉換邏輯，不需要掛載元件或模擬 WebSocket。
 */

export const initialSessionState = {
  status: 'idle',
  agents: [],
  activeSpeakerIds: [],
  routingMode: null,
  pendingAgentIds: [],
  transcript: [],
  lastError: null,
}

let _uidCounter = 0
function nextId() {
  _uidCounter += 1
  return `entry-${_uidCounter}`
}

/** 供測試重置計數器，避免測試之間互相影響 id 序號。 */
export function _resetIdCounterForTests() {
  _uidCounter = 0
}

export function agentSessionReducer(state, action) {
  switch (action.type) {
    case 'connecting':
      return { ...state, status: 'connecting' }

    case 'session_ready':
      return {
        ...state,
        status: 'ready',
        agents: action.agents || [],
      }

    case 'user_transcript':
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: nextId(),
            kind: 'user',
            text: action.text,
            engineUsed: action.engine_used,
            usedFallback: !!action.used_fallback,
          },
        ],
      }

    case 'routing_decision':
      return {
        ...state,
        routingMode: action.mode,
        pendingAgentIds: action.agent_ids || [],
      }

    case 'agent_speaking_start':
      return {
        ...state,
        activeSpeakerIds: state.activeSpeakerIds.includes(action.agent_id)
          ? state.activeSpeakerIds
          : [...state.activeSpeakerIds, action.agent_id],
      }

    case 'agent_speaking_chunk':
      // 一句話的 TTS 串流常常會分成好幾個音訊 chunk，後端只在該句「第一個」
      // chunk 附帶文字（見 agents/orchestrator.py 的說明），後續 chunk 的
      // text 會是空字串——這裡不記錄空文字的 transcript 項目，避免同一句話
      // 重複顯示好幾次（重複次數 = 該句被分成的音訊 chunk 數）。
      if (!action.text) {
        return state
      }
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: nextId(),
            kind: 'agent',
            agentId: action.agent_id,
            text: action.text,
            hasAudio: !!action.audio,
          },
        ],
      }

    case 'agent_speaking_end':
      return {
        ...state,
        activeSpeakerIds: state.activeSpeakerIds.filter((id) => id !== action.agent_id),
      }

    case 'error':
      return {
        ...state,
        status: 'error',
        lastError: action.message,
      }

    case 'disconnected':
      return {
        ...state,
        status: 'idle',
        activeSpeakerIds: [],
      }

    case 'reset':
      return { ...initialSessionState }

    default:
      return state
  }
}
