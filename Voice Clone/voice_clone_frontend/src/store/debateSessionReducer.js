/**
 * debateSessionReducer.js — 辯論模式狀態機（純函式，方便單元測試）
 *
 * 跟 store/agentSessionReducer.js 的差異：
 *   - 多一個 'paused' 狀態（暫停中，等待使用者插話）與對應的 pausedAgentId
 *   - 多 topicId / topicTitle（辯論主題）
 *   - 多 isFinished（後端達到 debate_max_turns 上限，自然結束）
 *   - 固定只有兩位 agent，不需要 routingMode / pendingAgentIds
 *
 * 把 WebSocket 收到的 server 訊息（見 voice_clone_backend/models/schemas.py
 * 的 DebateServerMessage）轉換成 UI 狀態，刻意抽成與 React 無關的純函式，
 * 方便在 vitest 裡直接測試狀態轉換邏輯。
 */

export const initialDebateState = {
  status: 'idle', // 'idle' | 'connecting' | 'ready' | 'paused' | 'finished' | 'error'
  agents: [],
  topicId: null,
  topicTitle: '',
  activeSpeakerIds: [],
  pausedAgentId: null,
  transcript: [],
  isFinished: false,
  lastError: null,
}

let _uidCounter = 0
function nextId() {
  _uidCounter += 1
  return `debate-entry-${_uidCounter}`
}

/** 供測試重置計數器，避免測試之間互相影響 id 序號。 */
export function _resetIdCounterForTests() {
  _uidCounter = 0
}

export function debateSessionReducer(state, action) {
  switch (action.type) {
    case 'connecting':
      return { ...state, status: 'connecting' }

    case 'debate_ready':
      return {
        ...state,
        status: 'ready',
        agents: action.agents || [],
        topicId: action.topic_id || null,
        topicTitle: action.topic_title || '',
      }

    case 'agent_speaking_start':
      return {
        ...state,
        status: 'ready',
        pausedAgentId: null,
        activeSpeakerIds: state.activeSpeakerIds.includes(action.agent_id)
          ? state.activeSpeakerIds
          : [...state.activeSpeakerIds, action.agent_id],
      }

    case 'agent_speaking_chunk':
      // 跟一般多 Agent 對話一樣：後端只在該句第一個音訊 chunk 附帶文字，
      // 避免同一句話因為分成多個音訊 chunk 而在 transcript 重複顯示好幾次。
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

    case 'debate_paused':
      return {
        ...state,
        status: 'paused',
        pausedAgentId: action.agent_id,
        activeSpeakerIds: state.activeSpeakerIds.filter((id) => id !== action.agent_id),
      }

    case 'user_intervene_ack':
      return {
        ...state,
        status: 'ready',
        pausedAgentId: null,
        transcript: [
          ...state.transcript,
          {
            id: nextId(),
            kind: 'user',
            text: action.text,
            engineUsed: 'typed',
            usedFallback: false,
          },
        ],
      }

    case 'debate_finished':
      return { ...state, status: 'finished', isFinished: true, activeSpeakerIds: [] }

    case 'error':
      return { ...state, status: 'error', lastError: action.message }

    case 'disconnected':
      return { ...state, status: 'idle', activeSpeakerIds: [] }

    case 'reset':
      return { ...initialDebateState }

    default:
      return state
  }
}
