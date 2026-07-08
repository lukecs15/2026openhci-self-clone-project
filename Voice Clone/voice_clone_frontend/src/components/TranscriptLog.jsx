/**
 * TranscriptLog.jsx — 對話紀錄面板
 *
 * 顯示使用者發言（含 STT 使用的引擎、是否 fallback）與各 agent 逐句回覆。
 * 一般多 Agent 對話與辯論模式共用這個元件（VoiceAgentsPage.jsx 的 chat 分支、
 * DebateStage.jsx 都是直接 render 這個元件），這裡修正的自動捲動兩邊都會
 * 一起套用，不需要各自處理。
 *
 * 自動捲動到底部（修過的真實回報問題：有新訊息時要手動捲到最下面才看得
 * 到）：用一個掛在清單最後的空 div（bottomRef）搭配 scrollIntoView()，
 * 每次 transcript 長度變化（新增一則訊息）就捲過去。用 length 而不是整個
 * transcript 陣列當 useEffect 依賴，是因為陣列參照每次 render 都可能不同，
 * 只在「真的多了一則」時捲動即可，不需要每次 render 都觸發。
 */

import { useEffect, useRef } from 'react'

export default function TranscriptLog({ transcript, agents }) {
  const nameFor = (agentId) => agents.find((a) => a.agent_id === agentId)?.display_name || agentId
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [transcript.length])

  return (
    <div
      style={{
        maxHeight: '360px',
        overflowY: 'auto',
        padding: '1rem',
        background: '#0f172a',
        borderRadius: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      {transcript.length === 0 && (
        <div style={{ color: '#475569', fontSize: '0.85rem' }}>對話紀錄會顯示在這裡。</div>
      )}
      {transcript.map((entry) => (
        <div key={entry.id} style={{ fontSize: '0.9rem' }}>
          {entry.kind === 'user' ? (
            <span style={{ color: '#38bdf8' }}>
              你：{entry.text}
              {entry.usedFallback && (
                <em style={{ color: '#f59e0b', marginLeft: '0.5rem', fontSize: '0.75rem' }}>
                  （STT 已切換備援引擎：{entry.engineUsed}）
                </em>
              )}
            </span>
          ) : (
            <span style={{ color: '#a5b4fc' }}>
              {nameFor(entry.agentId)}：{entry.text}
            </span>
          )}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
