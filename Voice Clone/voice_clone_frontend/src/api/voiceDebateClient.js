/**
 * voiceDebateClient.js — 辯論模式 WebSocket 訊息組裝
 *
 * 對應後端 routers/ws_debate.py（WS /ws/voice-debate/{session_id}）與
 * models/schemas.py 底部「辯論模式 WebSocket 訊息協定」的說明。
 *
 * DEBATE_TOPIC_OPTIONS 的 topic_id 必須跟後端 agents/debate.py 的
 * DEFAULT_DEBATE_TOPICS 三個 key 完全一致（failure / boundaries /
 * procrastination）。前端選單只需要 id + 顯示用標題，完整的辯論引導文字
 * （seed_prompt）留在後端，不需要同步到前端。
 */

export const DEBATE_TOPIC_OPTIONS = [
  { topic_id: 'failure', title: '如何面對失敗與挫折' },
  { topic_id: 'boundaries', title: '如何設立個人界線，兼顧他人期待與自己的需求' },
  { topic_id: 'procrastination', title: '如何克服拖延，建立自律' },
]

/**
 * @param {string} topicId 對應 DEBATE_TOPIC_OPTIONS 其中一個 topic_id
 * @param {Array} agents 恰好 2 位 agent（AgentConfig），順序即發言順序
 */
export function buildInitDebateSessionMessage(topicId, agents) {
  return { type: 'init_debate_session', topic_id: topicId, agents }
}

/** 立刻中斷目前正在生成/播放的那句話（後端會 cancel 掉背景生成 task）。 */
export function buildPauseDebateMessage() {
  return { type: 'pause_debate' }
}

/** 插話：通常在 pause_debate 之後送出，由後端記錄後讓被打斷的 agent 接續回應。 */
export function buildUserInterveneMessage(text) {
  return { type: 'user_intervene', text }
}

/**
 * 回報「這一輪的音訊/朗讀真的播完了」（見 useDebateSession.js 事件序列化
 * 管線說明），讓後端在換人發言前等待這個訊號，不會自顧自跑到比使用者
 * 實際聽到的還前面——修過的真實回報問題：插話後接續回應的是錯的 agent，
 * 見 routers/ws_debate.py 檔案開頭「等待前端回報播放完成」的說明。
 */
export function buildTurnPlayedMessage(agentId) {
  return { type: 'turn_played', agent_id: agentId }
}

export function buildEndDebateSessionMessage() {
  return { type: 'end_session' }
}
