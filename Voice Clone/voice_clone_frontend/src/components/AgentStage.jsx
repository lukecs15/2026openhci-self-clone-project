/**
 * AgentStage.jsx — 多 Agent 頭像舞台
 *
 * 顯示所有 agent（目標支援 3 個以上同時參與），正在發話的 agent 會被
 * 高亮（activeSpeakerIds 可能同時包含多個 id，對應 job_group 情境）。
 *
 * 頭像改用動態波形呈現（WaveformAvatar.jsx，見 utils/waveformSignature.js
 * / utils/waveformPath.js / utils/emotionSignal.js 的設計說明）：波紋鋪滿
 * 整個 agent 方框的背景（不是限縮在一個小圓形頭像裡），名稱／角色標籤用
 * 底部漸層疊在波形上方維持可讀性；方框邊框跟外發光在說話中會用該 agent
 * 的波形色相點亮，呼應波紋本身的顏色。這個元件同時是多 Agent 對話
 * （VoiceAgentsPage.jsx 的 chat 分支）與辯論模式（DebateStage.jsx）共用的
 * 元件，波形頭像兩邊會一起套用，不需要各自處理。
 *
 * `transcript` 是新增的 prop（預設空陣列，向後相容舊的呼叫端）：用來算出
 * 「這位 agent 最新一句話說了什麼」，交給 WaveformAvatar 依情緒微調波形
 * 形狀（見 utils/emotionSignal.js）。沒有 transcript 資料的舊呼叫端仍然
 * 能正常運作，只是波形會維持在角色的基準狀態，不會有逐句的情緒變化。
 */

import { useMemo } from 'react'
import { getWaveformSignature } from '../utils/waveformSignature'
import WaveformAvatar from './WaveformAvatar'

/** 從 transcript 算出每位 agent「最新一句話」的文字，供波形情緒分析使用。 */
function buildLatestTextByAgent(transcript) {
  const map = {}
  transcript.forEach((entry) => {
    if (entry.kind === 'agent' && entry.agentId) {
      map[entry.agentId] = entry.text
    }
  })
  return map
}

export default function AgentStage({
  agents,
  activeSpeakerIds,
  pendingAgentIds,
  routingMode,
  transcript = [],
}) {
  const latestTextByAgent = useMemo(() => buildLatestTextByAgent(transcript), [transcript])

  return (
    <div
      style={{
        display: 'flex',
        gap: '1rem',
        padding: '1.5rem',
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}
    >
      {agents.map((agent) => {
        const isSpeaking = activeSpeakerIds.includes(agent.agent_id)
        const isPending = pendingAgentIds.includes(agent.agent_id) && !isSpeaking
        const signature = getWaveformSignature(agent)
        const glowColor = `hsl(${signature.hue}, 85%, 60%)`

        return (
          <div
            key={agent.agent_id}
            style={{
              position: 'relative',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              width: '150px',
              height: '116px',
              borderRadius: '1rem',
              border: isPending ? '2px dashed #6366f1' : `2px solid ${isSpeaking ? glowColor : '#1e293b'}`,
              boxShadow: isSpeaking ? `0 0 20px 2px ${glowColor}66` : 'none',
              transition: 'border-color 0.25s, box-shadow 0.25s',
            }}
          >
            <div style={{ position: 'absolute', inset: 0 }}>
              <WaveformAvatar
                signature={signature}
                isSpeaking={isSpeaking}
                currentText={latestTextByAgent[agent.agent_id]}
              />
            </div>

            <div
              style={{
                position: 'relative',
                padding: '0.5rem 0.65rem 0.4rem',
                background:
                  'linear-gradient(to top, rgba(2,6,23,0.92) 10%, rgba(2,6,23,0.35) 65%, rgba(2,6,23,0))',
                color: '#f8fafc',
                textAlign: 'center',
              }}
            >
              <strong style={{ fontSize: '0.95rem' }}>{agent.display_name}</strong>
              {agent.role_tag && (
                <div style={{ fontSize: '0.72rem', opacity: 0.85 }}>{agent.role_tag}</div>
              )}
              {isSpeaking && <div style={{ fontSize: '0.68rem', marginTop: '0.15rem' }}>發話中…</div>}
            </div>
          </div>
        )
      })}
      {routingMode && (
        <div
          style={{
            width: '100%',
            textAlign: 'center',
            fontSize: '0.8rem',
            color: '#64748b',
            marginTop: '0.5rem',
          }}
        >
          目前路由模式：{routingMode === 'job_group' ? 'Job Group（多角色平行回應）' : 'Handoff（單一角色序列交接）'}
        </div>
      )}
    </div>
  )
}
