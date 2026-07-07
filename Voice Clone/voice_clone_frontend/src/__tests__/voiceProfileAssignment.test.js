/**
 * voiceProfileAssignment.test.js — 驗證聲音克隆 profile 套用到單一 / 全部 agent 的邏輯
 */

import { describe, it, expect } from 'vitest'
import {
  applyVoiceProfileToAgents,
  clearVoiceProfileFromAgents,
  ASSIGN_TARGET_ALL,
} from '../store/voiceProfileAssignment'

const agents = [
  { agent_id: 'agent-a', display_name: '小明', voice_profile_id: '' },
  { agent_id: 'agent-b', display_name: '小華', voice_profile_id: '' },
  { agent_id: 'agent-c', display_name: '阿德', voice_profile_id: '' },
]

describe('applyVoiceProfileToAgents', () => {
  it('套用到單一 agent 時，只有該 agent 的 voice_profile_id 被更新', () => {
    const next = applyVoiceProfileToAgents(agents, 'profile-123', 'agent-b')

    expect(next.find((a) => a.agent_id === 'agent-a').voice_profile_id).toBe('')
    expect(next.find((a) => a.agent_id === 'agent-b').voice_profile_id).toBe('profile-123')
    expect(next.find((a) => a.agent_id === 'agent-c').voice_profile_id).toBe('')
  })

  it('套用到全部 agent 時，所有 agent 都拿到同一個 profileId', () => {
    const next = applyVoiceProfileToAgents(agents, 'profile-123', ASSIGN_TARGET_ALL)

    expect(next.every((a) => a.voice_profile_id === 'profile-123')).toBe(true)
    expect(next).toHaveLength(3)
  })

  it('profileId 為空時直接回傳原本的 agents（不變）', () => {
    const next = applyVoiceProfileToAgents(agents, '', 'agent-a')
    expect(next).toBe(agents)
  })

  it('不會修改原本傳入的 agents 陣列（immutable）', () => {
    const original = JSON.parse(JSON.stringify(agents))
    applyVoiceProfileToAgents(agents, 'profile-123', ASSIGN_TARGET_ALL)
    expect(agents).toEqual(original)
  })

  it('target 為不存在的 agent_id 時，所有 agent 都維持原狀', () => {
    const next = applyVoiceProfileToAgents(agents, 'profile-123', 'agent-does-not-exist')
    expect(next.every((a) => a.voice_profile_id === '')).toBe(true)
  })
})

describe('clearVoiceProfileFromAgents', () => {
  it('可以清除單一 agent 的 voice_profile_id', () => {
    const withProfile = applyVoiceProfileToAgents(agents, 'profile-123', ASSIGN_TARGET_ALL)
    const cleared = clearVoiceProfileFromAgents(withProfile, 'agent-a')

    expect(cleared.find((a) => a.agent_id === 'agent-a').voice_profile_id).toBe('')
    expect(cleared.find((a) => a.agent_id === 'agent-b').voice_profile_id).toBe('profile-123')
  })

  it('可以清除全部 agent 的 voice_profile_id', () => {
    const withProfile = applyVoiceProfileToAgents(agents, 'profile-123', ASSIGN_TARGET_ALL)
    const cleared = clearVoiceProfileFromAgents(withProfile, ASSIGN_TARGET_ALL)

    expect(cleared.every((a) => a.voice_profile_id === '')).toBe(true)
  })
})
