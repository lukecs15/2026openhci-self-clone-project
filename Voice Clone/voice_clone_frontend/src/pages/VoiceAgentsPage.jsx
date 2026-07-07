/**
 * VoiceAgentsPage.jsx — 多 Agent 語音對話展示頁
 *
 * 串接 useVoiceAgentSession（WebSocket + reducer + 錄音/播放），
 * 呈現 AgentStage（發話狀態）+ TranscriptLog（對話紀錄）+ MicControl（輸入）。
 *
 * 開始對話前多一個步驟：VoiceProfileUploader 讓使用者上傳/錄一段音訊，
 * 克隆出聲音後指派給某個 agent（或全部 agent），對話中該 agent 就會
 * 用使用者的克隆聲音回覆（實際克隆推理在後端 CosyVoice 2，見架構文件）。
 *
 * handleStart 直接呼叫 connect() 後立刻呼叫 initSession()，不需要用
 * setTimeout 賭連線速度——initSession 內部走 safeSend()，連線還沒 OPEN
 * 會自動排隊，onopen 時自動送出（見 hooks/useVoiceAgentSession.js）。
 *
 * 路由策略選擇（routingStrategy state）：預設「使用後端設定」，也就是不主動
 * 帶 routing_strategy 欄位，讓後端依 .env 的 AGENT_ROUTING_STRATEGY 決定。
 * 曾經的 bug：這裡以前是寫死呼叫 initSession(agents, 'heuristic')，等於
 * 前端每次都主動要求 heuristic，就算後端 .env 設成 llm_decision 也永遠不會
 * 生效——使用者回報「明明只想跟小明說話，另外兩個 agent 也跟著回話」，
 * 根本原因就是實際生效的路由邏輯其實還是 heuristic 的「完全沒比對到任何
 * agent 名字 → 全體依序回應」，不是 llm_decision（見 useVoiceAgentSession.js
 * / voiceAgentClient.js 的說明）。現在讓使用者可以在開始對話前明確選擇，
 * 也可以選「使用後端設定」保留原本交給 .env 決定的彈性。
 *
 * 兩個「瀏覽器端測試替代方案」開關（都預設關閉，跟後端 STT/TTS 是否 mock
 * 完全獨立，純粹是前端測試輔助）：
 *   - 用瀏覽器語音朗讀：後端 TTS 是 mock（靜音）時，用 Web Speech API 把
 *     agent 回覆的文字唸出來。
 *   - 用瀏覽器語音辨識：後端 STT 是 mock（永遠回固定文字）時，用 Web
 *     Speech API 就地辨識你說的話，辨識完直接當 user_text 送出。
 */

import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useVoiceAgentSession } from '../hooks/useVoiceAgentSession'
import { DEFAULT_DEMO_AGENTS } from '../api/voiceAgentClient'
import { applyVoiceProfileToAgents } from '../store/voiceProfileAssignment'
import AgentStage from '../components/AgentStage'
import TranscriptLog from '../components/TranscriptLog'
import MicControl from '../components/MicControl'
import VoiceProfileUploader from '../components/VoiceProfileUploader'

const ROUTING_STRATEGY_OPTIONS = [
  { value: '', label: '使用後端設定（.env 的 AGENT_ROUTING_STRATEGY）' },
  { value: 'heuristic', label: 'heuristic（規則式，指名或依序輪流，不呼叫 LLM）' },
  { value: 'llm_decision', label: 'llm_decision（呼叫 LLM 判斷該由誰回應）' },
]

function DevToggleLabel({ checked, disabled, onChange, title, children }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        fontSize: '0.8rem',
        color: '#94a3b8',
        margin: '0.35rem 0',
        opacity: disabled ? 0.5 : 1,
      }}
      title={title}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      {children}
    </label>
  )
}

export default function VoiceAgentsPage() {
  const sessionId = useMemo(() => uuidv4(), [])
  const [started, setStarted] = useState(false)
  const [agents, setAgents] = useState(DEFAULT_DEMO_AGENTS)
  const [routingStrategy, setRoutingStrategy] = useState('')
  const {
    state,
    isRecording,
    connect,
    initSession,
    sendText,
    startRecording,
    stopRecording,
    browserTtsEnabled,
    toggleBrowserTts,
    isBrowserTtsSupported,
    browserSttEnabled,
    toggleBrowserStt,
    isBrowserSttSupported,
  } = useVoiceAgentSession(sessionId)

  const handleApplyVoiceProfile = (profileId, target) => {
    setAgents((prev) => applyVoiceProfileToAgents(prev, profileId, target))
  }

  const handleStart = () => {
    connect()
    // routingStrategy 是空字串時故意傳 undefined，讓 initSession 不帶
    // routing_strategy 欄位，交給後端依 .env 設定決定（見檔案開頭說明）。
    initSession(agents, routingStrategy || undefined)
    setStarted(true)
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#020617',
        color: '#e2e8f0',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <header style={{ padding: '1.5rem 2rem', borderBottom: '1px solid #1e293b' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>
          台灣腔克隆語音多 Agent 對話系統
        </h1>
        <p style={{ margin: '0.25rem 0 0', color: '#64748b', fontSize: '0.85rem' }}>
          狀態：{state.status} ・ Session：{sessionId.slice(0, 8)}
        </p>
      </header>

      <main style={{ maxWidth: '720px', margin: '0 auto', padding: '1.5rem' }}>
        {!started ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <VoiceProfileUploader agents={agents} onApply={handleApplyVoiceProfile} />
            <ul style={{ fontSize: '0.8rem', color: '#94a3b8', paddingLeft: '1.2rem' }}>
              {agents.map((agent) => (
                <li key={agent.agent_id}>
                  {agent.display_name}
                  {agent.voice_profile_id ? '（已套用你的克隆聲音）' : '（預設音色）'}
                </li>
              ))}
            </ul>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.8rem', color: '#94a3b8' }}>
              路由策略（誰該回應由誰決定）
              <select
                value={routingStrategy}
                onChange={(e) => setRoutingStrategy(e.target.value)}
                style={{
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.5rem',
                  border: '1px solid #334155',
                  background: '#0f172a',
                  color: '#e2e8f0',
                }}
              >
                {ROUTING_STRATEGY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={handleStart}
              style={{
                padding: '0.75rem 1.5rem',
                borderRadius: '0.5rem',
                border: 'none',
                background: '#6366f1',
                color: '#fff',
                fontWeight: 700,
                cursor: 'pointer',
                alignSelf: 'flex-start',
              }}
            >
              開始對話
            </button>
          </div>
        ) : (
          <>
            <AgentStage
              agents={state.agents}
              activeSpeakerIds={state.activeSpeakerIds}
              pendingAgentIds={state.pendingAgentIds}
              routingMode={state.routingMode}
            />
            <DevToggleLabel
              checked={browserTtsEnabled}
              disabled={!isBrowserTtsSupported}
              onChange={(e) => toggleBrowserTts(e.target.checked)}
              title={
                isBrowserTtsSupported
                  ? '後端 TTS 若還是 mock（靜音），開啟這個開關可以用瀏覽器內建語音朗讀 agent 的文字，方便測試播放時序，不影響實際 CosyVoice 2 克隆語音功能'
                  : '目前瀏覽器不支援 Web Speech API'
              }
            >
              用瀏覽器語音朗讀（TTS 為 mock 時的測試用替代方案）
            </DevToggleLabel>
            <DevToggleLabel
              checked={browserSttEnabled}
              disabled={!isBrowserSttSupported}
              onChange={(e) => toggleBrowserStt(e.target.checked)}
              title={
                isBrowserSttSupported
                  ? '後端 STT 若還是 mock（永遠回固定文字），開啟這個開關後「按住說話」改用瀏覽器內建語音辨識，辨識完直接以文字送出，不影響實際 Breeze ASR/faster-whisper 功能'
                  : '目前瀏覽器不支援 Web Speech API'
              }
            >
              用瀏覽器語音辨識（STT 為 mock 時的測試用替代方案）
            </DevToggleLabel>
            <TranscriptLog transcript={state.transcript} agents={state.agents} />
            <MicControl
              isRecording={isRecording}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onSendText={sendText}
            />
            {state.lastError && (
              <p style={{ color: '#ef4444', fontSize: '0.85rem' }}>錯誤：{state.lastError}</p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
