/**
 * VoiceAgentsPage.jsx — 語音對話展示頁（一般多 Agent 對話 / 自我省思辯論）
 *
 * 兩個模式共用同一個進入畫面，模式選擇本身是畫面裡的一個下拉選單（不是
 * App.jsx 最上層的切換 bar），選單順序：路由策略 → 模式 → （辯論模式才
 * 出現的）主題／兩位 agent 選擇，符合「模式選項放在路由策略下面」的需求。
 *
 * ── 一般多 Agent 對話（appMode==='chat'）──────────────────────────
 * 串接 useVoiceAgentSession（WebSocket + reducer + 錄音/播放），呈現
 * AgentStage（發話狀態）+ TranscriptLog（對話紀錄）+ MicControl（輸入）。
 *
 * handleStart 直接呼叫 connect() 後立刻呼叫 initSession()，不需要用
 * setTimeout 賭連線速度——initSession 內部走 safeSend()，連線還沒 OPEN
 * 會自動排隊，onopen 時自動送出（見 hooks/useVoiceAgentSession.js）。
 *
 * 路由策略選擇（routingStrategy state）：預設「使用後端設定」，也就是不主動
 * 帶 routing_strategy 欄位，讓後端依 .env 的 AGENT_ROUTING_STRATEGY 決定。
 * 曾經的 bug：這裡以前是寫死呼叫 initSession(agents, 'heuristic')，等於
 * 前端每次都主動要求 heuristic，就算後端 .env 設成 llm_decision 也永遠不會
 * 生效，見 useVoiceAgentSession.js / voiceAgentClient.js 的說明。
 *
 * ── 自我省思辯論（appMode==='debate'）──────────────────────────────
 * 選一個主題（三選一）+ 選兩位 agent（三選二，選擇順序即發言順序）後開始，
 * 串接 useDebateSession + DebateStage（暫停/插話、半透明結束按鈕）。
 * agent 清單跟一般多 Agent 對話共用同一個 `agents` state（含已套用的
 * 聲音克隆 profile），不是另外寫死一份——選擇框裡若該 agent 已套用克隆
 * 聲音會加註「已套用克隆聲音」，讓使用者確認辯論模式跟一般多 Agent 對話
 * 走的是同一套聲音克隆設定與生成流程，不是另外一套。
 *
 * 兩組「瀏覽器端測試替代方案」開關（都預設關閉，跟後端 STT/TTS 是否 mock
 * 完全獨立，純粹是前端測試輔助，兩個模式各自獨立管理自己的開關狀態）：
 *   - 用瀏覽器語音朗讀：後端 TTS 是 mock（靜音）時，用 Web Speech API 把
 *     agent 回覆的文字唸出來。
 *   - 用瀏覽器語音辨識：後端 STT 是 mock，或（辯論模式）後端本來就沒有
 *     語音插話這條路徑時，用 Web Speech API 就地辨識你說的話再送出。
 */

import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useVoiceAgentSession } from '../hooks/useVoiceAgentSession'
import { useDebateSession } from '../hooks/useDebateSession'
import { DEFAULT_DEMO_AGENTS } from '../api/voiceAgentClient'
import { DEBATE_TOPIC_OPTIONS } from '../api/voiceDebateClient'
import { applyVoiceProfileToAgents } from '../store/voiceProfileAssignment'
import AgentStage from '../components/AgentStage'
import TranscriptLog from '../components/TranscriptLog'
import MicControl from '../components/MicControl'
import VoiceProfileUploader from '../components/VoiceProfileUploader'
import DebateStage from '../components/DebateStage'
import DevToggleLabel from '../components/DevToggleLabel'

const ROUTING_STRATEGY_OPTIONS = [
  { value: '', label: '使用後端設定（.env 的 AGENT_ROUTING_STRATEGY）' },
  { value: 'heuristic', label: 'heuristic（規則式，指名或依序輪流，不呼叫 LLM）' },
  { value: 'llm_decision', label: 'llm_decision（呼叫 LLM 判斷該由誰回應）' },
]

const APP_MODE_OPTIONS = [
  { value: 'chat', label: '一般多 Agent 對話' },
  { value: 'debate', label: '自我省思辯論' },
]

const selectStyle = {
  padding: '0.5rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid #334155',
  background: '#0f172a',
  color: '#e2e8f0',
}

export default function VoiceAgentsPage() {
  const chatSessionId = useMemo(() => uuidv4(), [])
  const debateSessionId = useMemo(() => uuidv4(), [])
  const [started, setStarted] = useState(false)
  const [agents, setAgents] = useState(DEFAULT_DEMO_AGENTS)
  const [routingStrategy, setRoutingStrategy] = useState('')
  const [appMode, setAppMode] = useState('chat') // 'chat' | 'debate'
  const [debateTopicId, setDebateTopicId] = useState('')
  const [debateAgentIds, setDebateAgentIds] = useState([])

  const chat = useVoiceAgentSession(chatSessionId)
  const debate = useDebateSession(debateSessionId)

  const handleApplyVoiceProfile = (profileId, target) => {
    setAgents((prev) => applyVoiceProfileToAgents(prev, profileId, target))
  }

  const toggleDebateAgent = (agentId) => {
    setDebateAgentIds((prev) => {
      if (prev.includes(agentId)) return prev.filter((id) => id !== agentId)
      if (prev.length >= 2) return prev // 已選滿 2 位，第三個點擊不生效
      return [...prev, agentId]
    })
  }

  const canStartDebate = !!debateTopicId && debateAgentIds.length === 2
  const canStart = appMode === 'chat' || canStartDebate

  const handleStart = () => {
    if (appMode === 'chat') {
      chat.connect()
      // routingStrategy 是空字串時故意傳 undefined，讓 initSession 不帶
      // routing_strategy 欄位，交給後端依 .env 設定決定（見檔案開頭說明）。
      chat.initSession(agents, routingStrategy || undefined)
    } else {
      if (!canStartDebate) return
      const selectedAgents = debateAgentIds
        .map((id) => agents.find((a) => a.agent_id === id))
        .filter(Boolean)
      debate.connect()
      debate.initDebateSession(debateTopicId, selectedAgents)
    }
    setStarted(true)
  }

  const handleEndDebateSession = () => {
    debate.endSession()
    debate.disconnect()
    setStarted(false)
    setDebateTopicId('')
    setDebateAgentIds([])
  }

  const activeStatus = appMode === 'chat' ? chat.state.status : debate.state.status
  const activeSessionId = appMode === 'chat' ? chatSessionId : debateSessionId
  const activeError = appMode === 'chat' ? chat.state.lastError : debate.state.lastError

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
          狀態：{activeStatus} ・ Session：{activeSessionId.slice(0, 8)}
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
              路由策略（誰該回應由誰決定，僅一般多 Agent 對話適用）
              <select
                value={routingStrategy}
                onChange={(e) => setRoutingStrategy(e.target.value)}
                style={selectStyle}
              >
                {ROUTING_STRATEGY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.8rem', color: '#94a3b8' }}>
              模式
              <select value={appMode} onChange={(e) => setAppMode(e.target.value)} style={selectStyle}>
                {APP_MODE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            {appMode === 'debate' && (
              <>
                <div>
                  <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>選一個討論主題</h2>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {DEBATE_TOPIC_OPTIONS.map((topic) => (
                      <label
                        key={topic.topic_id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.6rem 0.85rem',
                          borderRadius: '0.5rem',
                          border: debateTopicId === topic.topic_id ? '2px solid #6366f1' : '1px solid #334155',
                          background: '#0f172a',
                          color: '#e2e8f0',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="debate-topic"
                          checked={debateTopicId === topic.topic_id}
                          onChange={() => setDebateTopicId(topic.topic_id)}
                        />
                        {topic.title}
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
                    選兩位 Agent 進行討論（已選 {debateAgentIds.length}/2）
                  </h2>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {agents.map((agent) => {
                      const isSelected = debateAgentIds.includes(agent.agent_id)
                      const disabled = !isSelected && debateAgentIds.length >= 2
                      return (
                        <label
                          key={agent.agent_id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.6rem 0.85rem',
                            borderRadius: '0.5rem',
                            border: isSelected ? '2px solid #6366f1' : '1px solid #334155',
                            background: '#0f172a',
                            color: disabled ? '#475569' : '#e2e8f0',
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            opacity: disabled ? 0.6 : 1,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={disabled}
                            onChange={() => toggleDebateAgent(agent.agent_id)}
                          />
                          {agent.display_name}（{agent.role_tag}）
                          {agent.voice_profile_id && (
                            <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                              已套用克隆聲音
                            </span>
                          )}
                          {isSelected && (
                            <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                              第 {debateAgentIds.indexOf(agent.agent_id) + 1} 位發言
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                </div>
              </>
            )}

            <button
              onClick={handleStart}
              disabled={!canStart}
              style={{
                padding: '0.75rem 1.5rem',
                borderRadius: '0.5rem',
                border: 'none',
                background: canStart ? '#6366f1' : '#334155',
                color: '#fff',
                fontWeight: 700,
                cursor: canStart ? 'pointer' : 'not-allowed',
                alignSelf: 'flex-start',
              }}
            >
              {appMode === 'chat' ? '開始對話' : '開始討論'}
            </button>
          </div>
        ) : appMode === 'chat' ? (
          <>
            <AgentStage
              agents={chat.state.agents}
              activeSpeakerIds={chat.state.activeSpeakerIds}
              pendingAgentIds={chat.state.pendingAgentIds}
              routingMode={chat.state.routingMode}
              transcript={chat.state.transcript}
            />
            <DevToggleLabel
              checked={chat.browserTtsEnabled}
              disabled={!chat.isBrowserTtsSupported}
              onChange={(e) => chat.toggleBrowserTts(e.target.checked)}
              title={
                chat.isBrowserTtsSupported
                  ? '後端 TTS 若還是 mock（靜音），開啟這個開關可以用瀏覽器內建語音朗讀 agent 的文字，方便測試播放時序，不影響實際 CosyVoice 2 克隆語音功能'
                  : '目前瀏覽器不支援 Web Speech API'
              }
            >
              用瀏覽器語音朗讀（TTS 為 mock 時的測試用替代方案）
            </DevToggleLabel>
            <DevToggleLabel
              checked={chat.browserSttEnabled}
              disabled={!chat.isBrowserSttSupported}
              onChange={(e) => chat.toggleBrowserStt(e.target.checked)}
              title={
                chat.isBrowserSttSupported
                  ? '後端 STT 若還是 mock（永遠回固定文字），開啟這個開關後「按住說話」改用瀏覽器內建語音辨識，辨識完直接以文字送出，不影響實際 Breeze ASR/faster-whisper 功能'
                  : '目前瀏覽器不支援 Web Speech API'
              }
            >
              用瀏覽器語音辨識（STT 為 mock 時的測試用替代方案）
            </DevToggleLabel>
            <TranscriptLog transcript={chat.state.transcript} agents={chat.state.agents} />
            <MicControl
              isRecording={chat.isRecording}
              onStartRecording={chat.startRecording}
              onStopRecording={chat.stopRecording}
              onSendText={chat.sendText}
            />
          </>
        ) : (
          <DebateStage
            agents={debate.state.agents}
            topicTitle={debate.state.topicTitle}
            status={debate.state.status}
            activeSpeakerIds={debate.state.activeSpeakerIds}
            transcript={debate.state.transcript}
            onPause={debate.pauseDebate}
            onIntervene={debate.sendIntervention}
            onEndSession={handleEndDebateSession}
            browserTtsEnabled={debate.browserTtsEnabled}
            toggleBrowserTts={debate.toggleBrowserTts}
            isBrowserTtsSupported={debate.isBrowserTtsSupported}
            browserSttEnabled={debate.browserSttEnabled}
            toggleBrowserStt={debate.toggleBrowserStt}
            isBrowserSttSupported={debate.isBrowserSttSupported}
            isRecording={debate.isRecording}
            onStartRecording={debate.startRecording}
            onStopRecording={debate.stopRecording}
          />
        )}

        {activeError && <p style={{ color: '#ef4444', fontSize: '0.85rem' }}>錯誤：{activeError}</p>}
      </main>
    </div>
  )
}
