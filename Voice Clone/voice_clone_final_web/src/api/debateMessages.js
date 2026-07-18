/**
 * debateMessages.js — 辯論模式 WebSocket 訊息組裝
 *
 * 對應 voice_clone_backend/models/schemas.py 底部「辯論模式 WebSocket 訊息
 * 協定」。final web 一律走自訂議題（topic_id="custom" + 情境的 topicTitle），
 * 並帶 max_turns 逐場覆寫回合上限（三情境體驗每場較短，見後端
 * pipeline/debate_pipeline.py 的說明）。
 */

export function buildInitDebateSessionMessage(topicTitle, agents, maxTurns) {
  const msg = { type: 'init_debate_session', topic_id: 'custom', topic_title: topicTitle, agents }
  if (Number.isFinite(maxTurns) && maxTurns > 0) msg.max_turns = maxTurns
  return msg
}

/**
 * @param {string} [heardAgentId] 被打斷那一輪的 agent id
 * @param {string[]} [heardTexts] 該輪「前端實際已顯示」的句子（介入核對用，
 *   後端據此把對話歷史修剪成使用者真正看到的內容；不帶 = 後端行為不變）
 */
export function buildPauseDebateMessage(heardAgentId, heardTexts) {
  const msg = { type: 'pause_debate' }
  if (heardAgentId && Array.isArray(heardTexts)) {
    msg.agent_id = heardAgentId
    msg.heard_texts = heardTexts
  }
  return msg
}

/** 文字插話。 */
export function buildUserInterveneMessage(text) {
  return { type: 'user_intervene', text }
}

/** 語音插話（base64 WAV，後端 STT 轉錄後走跟文字插話相同的路徑）。 */
export function buildUserInterveneAudioMessage(base64Wav) {
  return { type: 'user_intervene_audio', audio: base64Wav }
}

/** 真實播放回報：這一輪的音訊真的播完了，後端才會生成下一輪（低延遲控時關鍵）。 */
export function buildTurnPlayedMessage(agentId) {
  return { type: 'turn_played', agent_id: agentId }
}

export function buildEndDebateSessionMessage() {
  return { type: 'end_session' }
}
