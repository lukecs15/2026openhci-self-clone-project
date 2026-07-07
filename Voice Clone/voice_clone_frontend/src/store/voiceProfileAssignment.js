/**
 * voiceProfileAssignment.js — 聲音克隆 profile 指派邏輯（純函式，方便單元測試）
 *
 * 對應需求：使用者上傳音訊克隆出聲音後，可以選擇：
 *   - 套用到單一 agent（target 傳該 agent 的 agent_id）
 *   - 套用到全部 agent（target 傳 'all'）
 *
 * 之所以獨立成純函式而不是寫在元件裡，是因為「指派邏輯」本身不需要
 * DOM/React，抽出來才能在 vitest 裡直接測試，不用掛載元件或模擬後端 API。
 */

export const ASSIGN_TARGET_ALL = 'all'

/**
 * @param {Array<{agent_id: string, voice_profile_id?: string}>} agents
 * @param {string} profileId 已建立好的聲音克隆 profile id（voice-profiles/clone 回傳的 profile_id）
 * @param {string} target 'all' 或某個 agent_id
 * @returns {Array} 套用後的新 agents 陣列（不會修改原本的 agents）
 */
export function applyVoiceProfileToAgents(agents, profileId, target) {
  if (!profileId) return agents

  if (target === ASSIGN_TARGET_ALL) {
    return agents.map((agent) => ({ ...agent, voice_profile_id: profileId }))
  }

  return agents.map((agent) =>
    agent.agent_id === target ? { ...agent, voice_profile_id: profileId } : agent,
  )
}

/**
 * 清除某個 agent（或全部）身上的 voice_profile_id，恢復成該 agent 原本的預設音色。
 * @param {Array} agents
 * @param {string} target 'all' 或某個 agent_id
 */
export function clearVoiceProfileFromAgents(agents, target) {
  if (target === ASSIGN_TARGET_ALL) {
    return agents.map((agent) => ({ ...agent, voice_profile_id: '' }))
  }
  return agents.map((agent) =>
    agent.agent_id === target ? { ...agent, voice_profile_id: '' } : agent,
  )
}
