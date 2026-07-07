/**
 * AgentStage.jsx — 多 Agent 頭像舞台
 *
 * 顯示所有 agent（目標支援 3 個以上同時參與），正在發話的 agent 會被
 * 高亮（activeSpeakerIds 可能同時包含多個 id，對應 job_group 情境）。
 */

export default function AgentStage({ agents, activeSpeakerIds, pendingAgentIds, routingMode }) {
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
        return (
          <div
            key={agent.agent_id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '1rem 1.25rem',
              borderRadius: '1rem',
              minWidth: '120px',
              background: isSpeaking ? '#6366f1' : '#0f172a',
              border: isPending ? '2px dashed #6366f1' : '2px solid #1e293b',
              transition: 'all 0.2s',
              color: isSpeaking ? '#fff' : '#94a3b8',
            }}
          >
            <div
              style={{
                width: '3rem',
                height: '3rem',
                borderRadius: '50%',
                background: isSpeaking ? '#fff' : '#1e293b',
                marginBottom: '0.5rem',
              }}
            />
            <strong>{agent.display_name}</strong>
            <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>{agent.role_tag}</span>
            {isSpeaking && <span style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>發話中…</span>}
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
