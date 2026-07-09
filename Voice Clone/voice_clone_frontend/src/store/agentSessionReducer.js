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
 *   - status             ：'idle' | 'connecting' | 'ready' | 'summary' | 'error'
 *   - summaryText        ：結束對話時 LLM 生成的總結性紀念語（見 'session_summary' action）
 *   - lastError          ：最後一次錯誤訊息
 *
 * 刻意把這個 reducer 抽成與 React 無關的純函式（不依賴 useReducer 以外的東西），
 * 才能在 vitest 裡直接測試狀態轉換邏輯，不需要掛載元件或模擬 WebSocket。
 *
 * ── 結束對話的總結紀念語（session_summary）──────────────────────────────
 * 使用者按下結束按鈕時，hook 會送出 end_session 給後端；後端在關閉連線前
 * 會用整場對話歷史請 LLM 生成一句總結性的鼓勵語，透過 session_summary 事件
 * 送回來（見 routers/ws_voice_agents.py 的 end_session 處理）。狀態切成
 * 'summary' 讓 UI 可以切換顯示全螢幕結束畫面（SessionSummaryScreen），
 * 不會被隨後的 WebSocket 斷線（disconnected）事件蓋掉——disconnected 只有
 * 在還沒進入 'summary' 狀態時才會把狀態重置回 'idle'（見下方 case 'disconnected'）。
 */

export const initialSessionState = {
  status: 'idle',
  agents: [],
  activeSpeakerIds: [],
  routingMode: null,
  pendingAgentIds: [],
  transcript: [],
  summaryText: '',
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

    case 'session_summary':
      return {
        ...state,
        status: 'summary',
        summaryText: action.text || '',
        activeSpeakerIds: [],
      }

    case 'error':
      return {
        ...state,
        status: 'error',
        lastError: action.message,
      }

    case 'disconnected':
      // 收到 session_summary 後，緊接著的 WebSocket 斷線（後端送完總結就
      // 會 break 出主迴圈、關閉連線）不應該把狀態蓋回 'idle'——使用者應該
      // 停留在結束畫面（SessionSummaryScreen），直到自己按下離開按鈕。
      if (state.status === 'summary') {
        return state
      }
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
