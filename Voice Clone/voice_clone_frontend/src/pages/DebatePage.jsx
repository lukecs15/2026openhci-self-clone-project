/**
 * DebatePage.jsx — 自我省思／自我成長主題辯論模式展示頁
 *
 * 流程：
 *   1. 選一個討論主題（三個自我省思／自我成長主題三選一）
 *   2. 選兩位 agent 進行討論或辯論（三選二，選擇順序即發言順序：
 *      第一個選的先開口）
 *   3. 開始討論 → DebateStage（可暫停中斷、插話介入、半透明結束按鈕）
 *   4. 結束後回到這裡，可以重新選主題/agent 開始下一場
 *
 * agent 清單重用 voiceAgentClient.js 的 DEFAULT_DEMO_AGENTS（跟一般多
 * Agent 對話頁共用同一組示範 agent 人設），主題清單見 voiceDebateClient.js
 * 的 DEBATE_TOPIC_OPTIONS（topic_id 需跟後端 agents/debate.py 的
 * DEFAULT_DEBATE_TOPICS 一致）。
 */

import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useDebateSession } from '../hooks/useDebateSession'
import { DEFAULT_DEMO_AGENTS } from '../api/voiceAgentClient'
import { DEBATE_TOPIC_OPTIONS } from '../api/voiceDebateClient'
import DebateStage from '../components/DebateStage'

export default function DebatePage() {
  const sessionId = useMemo(() => uuidv4(), [])
  const [started, setStarted] = useState(false)
  const [topicId, setTopicId] = useState('')
  const [selectedAgentIds, setSelectedAgentIds] = useState([])

  const { state, connect, disconnect, initDebateSession, pauseDebate, sendIntervention, endSession } =
    useDebateSession(sessionId)

  const toggleAgent = (agentId) => {
    setSelectedAgentIds((prev) => {
      if (prev.includes(agentId)) return prev.filter((id) => id !== agentId)
      if (prev.length >= 2) return prev // 已選滿 2 位，第三個點擊不生效
      return [...prev, agentId]
    })
  }

  const canStart = !!topicId && selectedAgentIds.length === 2

  const handleStart = () => {
    if (!canStart) return
    const selectedAgents = selectedAgentIds
      .map((id) => DEFAULT_DEMO_AGENTS.find((a) => a.agent_id === id))
      .filter(Boolean)
    connect()
    initDebateSession(topicId, selectedAgents)
    setStarted(true)
  }

  const handleEndSession = () => {
    endSession()
    disconnect()
    setStarted(false)
    setSelectedAgentIds([])
    setTopicId('')
  }

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '1.5rem' }}>
      <p style={{ margin: '0 0 1rem', color: '#64748b', fontSize: '0.85rem' }}>
        自我省思／自我成長主題辯論 ・ 狀態：{state.status} ・ Session：{sessionId.slice(0, 8)}
      </p>

      {!started ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>1. 選一個討論主題</h2>
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
                    border: topicId === topic.topic_id ? '2px solid #6366f1' : '1px solid #334155',
                    background: '#0f172a',
                    color: '#e2e8f0',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="debate-topic"
                    checked={topicId === topic.topic_id}
                    onChange={() => setTopicId(topic.topic_id)}
                  />
                  {topic.title}
                </label>
              ))}
            </div>
          </div>

          <div>
            <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
              2. 選兩位 Agent 進行討論（已選 {selectedAgentIds.length}/2）
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {DEFAULT_DEMO_AGENTS.map((agent) => {
                const isSelected = selectedAgentIds.includes(agent.agent_id)
                const disabled = !isSelected && selectedAgentIds.length >= 2
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
                      onChange={() => toggleAgent(agent.agent_id)}
                    />
                    {agent.display_name}（{agent.role_tag}）
                    {isSelected && (
                      <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                        第 {selectedAgentIds.indexOf(agent.agent_id) + 1} 位發言
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          </div>

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
            開始討論
          </button>
        </div>
      ) : (
        <DebateStage
          agents={state.agents}
          topicTitle={state.topicTitle}
          status={state.status}
          activeSpeakerIds={state.activeSpeakerIds}
          transcript={state.transcript}
          onPause={pauseDebate}
          onIntervene={sendIntervention}
          onEndSession={handleEndSession}
        />
      )}

      {state.lastError && (
        <p style={{ color: '#ef4444', fontSize: '0.85rem' }}>錯誤：{state.lastError}</p>
      )}
    </div>
  )
}
