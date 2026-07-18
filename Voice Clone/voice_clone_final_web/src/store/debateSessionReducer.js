/**
 * debateSessionReducer.js — final web 辯論狀態機（純函式）
 *
 * 改寫自 voice_clone_frontend/src/store/debateSessionReducer.js，差異：
 *   - session_summary 額外保留結構化 verdict（後端 ws_debate.py 會帶，
 *     final web 的三情境報告要用它整理每個情境的討論摘要與介入思考變化）
 *   - transcript 條目記錄 sampleRate（除錯用）
 *   - interventionCount：user_intervene_ack 時 +1（每情境上限由 UI 控制）
 */

export const initialDebateState = {
  status: 'idle', // 'idle' | 'connecting' | 'ready' | 'paused' | 'finished' | 'summary' | 'error'
  agents: [],
  topicTitle: '',
  activeSpeakerIds: [],
  pausedAgentId: null,
  transcript: [],
  isFinished: false,
  summaryText: '',
  verdict: null,
  interventionCount: 0,
  lastError: null,
}

let _uidCounter = 0
function nextId() {
  _uidCounter += 1
  return `final-debate-entry-${_uidCounter}`
}

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
      // 後端只在該句第一個音訊 chunk 附帶文字（避免同一句在 transcript
      // 重複顯示），沒有文字的後續 chunk 不改狀態。
      if (!action.text) return state
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
      // 清空「全部」發言者而不是只移除 action.agent_id：被打斷那一輪的
      // agent_speaking_end 事件已被暫停的 epoch 機制作廢、永遠不會 dispatch，
      // 只過濾單一 id 會讓被打斷的 agent 永遠留在 activeSpeakerIds 裡——
      // 介入後新一輪開始時列表變成 [被打斷者, 實際發言者]，取 [0] 的球體
      // 發光就會指向錯的人（修過的真實問題：介入後「畫面上是被打斷的球在
      // 講話，聲音卻是另一個立場」）。
      return {
        ...state,
        status: 'paused',
        pausedAgentId: action.agent_id,
        activeSpeakerIds: [],
      }

    case 'user_transcript':
      // 語音介入的辨識結果（緊接著會收到 user_intervene_ack，由那則負責
      // 寫進 transcript；這裡不動狀態，避免同一句顯示兩次）。
      return state

    case 'user_intervene_ack':
      return {
        ...state,
        status: 'ready',
        pausedAgentId: null,
        interventionCount: state.interventionCount + 1,
        transcript: [
          ...state.transcript,
          { id: nextId(), kind: 'user', text: action.text },
        ],
      }

    case 'debate_finished':
      return { ...state, status: 'finished', isFinished: true, activeSpeakerIds: [] }

    case 'session_summary':
      return {
        ...state,
        status: 'summary',
        summaryText: action.text || '',
        verdict: action.verdict || null,
        activeSpeakerIds: [],
      }

    case 'error':
      return { ...state, status: 'error', lastError: action.message || '發生未知錯誤' }

    case 'disconnected':
      // summary 是正常結束（後端送完總結會關閉連線），不要把結束畫面蓋掉
      if (state.status === 'summary') return state
      return { ...state, status: 'idle', activeSpeakerIds: [] }

    case 'reset':
      return { ...initialDebateState }

    default:
      return state
  }
}
