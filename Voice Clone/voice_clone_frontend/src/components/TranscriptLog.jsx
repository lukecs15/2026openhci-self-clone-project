/**
 * TranscriptLog.jsx — 對話紀錄面板
 *
 * 顯示使用者發言（含 STT 使用的引擎、是否 fallback）與各 agent 逐句回覆。
 */

export default function TranscriptLog({ transcript, agents }) {
  const nameFor = (agentId) => agents.find((a) => a.agent_id === agentId)?.display_name || agentId

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
    </div>
  )
}
