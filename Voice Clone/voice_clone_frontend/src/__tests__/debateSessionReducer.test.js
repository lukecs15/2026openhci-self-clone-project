/**
 * debateSessionReducer.test.js — 驗證辯論模式狀態機（純函式，無需掛載元件/模擬 WebSocket）
 *
 * 重點涵蓋跟一般多 Agent 對話 reducer 不同的地方：暫停/插話狀態轉換、
 * topicTitle 設定、達到回合上限後的 finished 狀態。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  debateSessionReducer,
  initialDebateState,
  _resetIdCounterForTests,
} from '../store/debateSessionReducer'

describe('debateSessionReducer', () => {
  beforeEach(() => {
    _resetIdCounterForTests()
  })

  it('debate_ready 設定 agents／主題並將狀態轉為 ready', () => {
    const agents = [
      { agent_id: 'a', display_name: '小明' },
      { agent_id: 'b', display_name: '小華' },
    ]
    const next = debateSessionReducer(initialDebateState, {
      type: 'debate_ready',
      agents,
      topic_id: 'failure',
      topic_title: '如何面對失敗與挫折',
    })
    expect(next.status).toBe('ready')
    expect(next.agents).toEqual(agents)
    expect(next.topicId).toBe('failure')
    expect(next.topicTitle).toBe('如何面對失敗與挫折')
  })

  it('agent_speaking_start 加入 activeSpeakerIds 並清除 pausedAgentId', () => {
    const state = { ...initialDebateState, status: 'paused', pausedAgentId: 'a' }
    const next = debateSessionReducer(state, { type: 'agent_speaking_start', agent_id: 'a' })
    expect(next.status).toBe('ready')
    expect(next.activeSpeakerIds).toEqual(['a'])
    expect(next.pausedAgentId).toBeNull()
  })

  it('agent_speaking_chunk 文字為空時不新增 transcript 項目', () => {
    let state = debateSessionReducer(initialDebateState, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '我先說一點想法',
      audio: 'chunk-1',
    })
    state = debateSessionReducer(state, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '',
      audio: 'chunk-2',
    })
    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0].text).toBe('我先說一點想法')
  })

  it('agent_speaking_end 從 activeSpeakerIds 移除該 agent', () => {
    const state = { ...initialDebateState, activeSpeakerIds: ['a', 'b'] }
    const next = debateSessionReducer(state, { type: 'agent_speaking_end', agent_id: 'a' })
    expect(next.activeSpeakerIds).toEqual(['b'])
  })

  it('debate_paused 把 status 轉成 paused、記錄 pausedAgentId、從 activeSpeakerIds 移除該 agent', () => {
    const state = { ...initialDebateState, status: 'ready', activeSpeakerIds: ['a'] }
    const next = debateSessionReducer(state, { type: 'debate_paused', agent_id: 'a' })
    expect(next.status).toBe('paused')
    expect(next.pausedAgentId).toBe('a')
    expect(next.activeSpeakerIds).toEqual([])
  })

  it('user_intervene_ack 把 status 轉回 ready、清除 pausedAgentId、附加使用者插話到 transcript', () => {
    const state = { ...initialDebateState, status: 'paused', pausedAgentId: 'a' }
    const next = debateSessionReducer(state, {
      type: 'user_intervene_ack',
      text: '我想先問一下',
    })
    expect(next.status).toBe('ready')
    expect(next.pausedAgentId).toBeNull()
    expect(next.transcript).toHaveLength(1)
    expect(next.transcript[0]).toMatchObject({ kind: 'user', text: '我想先問一下' })
  })

  it('debate_finished 設定 status 為 finished 與 isFinished', () => {
    const state = { ...initialDebateState, status: 'ready', activeSpeakerIds: ['a'] }
    const next = debateSessionReducer(state, { type: 'debate_finished' })
    expect(next.status).toBe('finished')
    expect(next.isFinished).toBe(true)
    expect(next.activeSpeakerIds).toEqual([])
  })

  it('error 設定 status 與 lastError', () => {
    const next = debateSessionReducer(initialDebateState, { type: 'error', message: '連線失敗' })
    expect(next.status).toBe('error')
    expect(next.lastError).toBe('連線失敗')
  })

  it('disconnected 重置 status 與 activeSpeakerIds', () => {
    const state = { ...initialDebateState, status: 'ready', activeSpeakerIds: ['a'] }
    const next = debateSessionReducer(state, { type: 'disconnected' })
    expect(next.status).toBe('idle')
    expect(next.activeSpeakerIds).toEqual([])
  })

  it('未知 action type 回傳原本 state（不變）', () => {
    const next = debateSessionReducer(initialDebateState, { type: 'unknown_action' })
    expect(next).toBe(initialDebateState)
  })

  it('完整流程：ready → speaking → paused → 插話 → 再次 speaking', () => {
    let state = debateSessionReducer(initialDebateState, {
      type: 'debate_ready',
      agents: [{ agent_id: 'a', display_name: '小明' }],
      topic_id: 'failure',
      topic_title: '如何面對失敗與挫折',
    })
    state = debateSessionReducer(state, { type: 'agent_speaking_start', agent_id: 'a' })
    state = debateSessionReducer(state, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '我先講一點',
    })
    // 使用者按暫停，後端回報 debate_paused
    state = debateSessionReducer(state, { type: 'debate_paused', agent_id: 'a' })
    expect(state.status).toBe('paused')
    expect(state.activeSpeakerIds).toEqual([])

    // 使用者插話
    state = debateSessionReducer(state, { type: 'user_intervene_ack', text: '我有個問題' })
    expect(state.status).toBe('ready')
    expect(state.transcript).toHaveLength(2) // agent 發言 + 使用者插話

    // 被打斷的 agent 接續回應
    state = debateSessionReducer(state, { type: 'agent_speaking_start', agent_id: 'a' })
    expect(state.activeSpeakerIds).toEqual(['a'])
  })
})
