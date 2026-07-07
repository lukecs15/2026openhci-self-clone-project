/**
 * agentSessionReducer.test.js — 驗證多 Agent 對話狀態機（純函式，無需掛載元件/模擬 WebSocket）
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  agentSessionReducer,
  initialSessionState,
  _resetIdCounterForTests,
} from '../store/agentSessionReducer'

describe('agentSessionReducer', () => {
  beforeEach(() => {
    _resetIdCounterForTests()
  })

  it('session_ready 設定 agents 並將狀態轉為 ready', () => {
    const agents = [{ agent_id: 'a', display_name: '小明' }]
    const next = agentSessionReducer(initialSessionState, { type: 'session_ready', agents })
    expect(next.status).toBe('ready')
    expect(next.agents).toEqual(agents)
  })

  it('user_transcript 附加使用者發言紀錄，含 fallback 資訊', () => {
    const next = agentSessionReducer(initialSessionState, {
      type: 'user_transcript',
      text: '你好',
      engine_used: 'faster_whisper',
      used_fallback: true,
    })
    expect(next.transcript).toHaveLength(1)
    expect(next.transcript[0]).toMatchObject({
      kind: 'user',
      text: '你好',
      engineUsed: 'faster_whisper',
      usedFallback: true,
    })
  })

  it('routing_decision 更新 routingMode 與 pendingAgentIds', () => {
    const next = agentSessionReducer(initialSessionState, {
      type: 'routing_decision',
      mode: 'job_group',
      agent_ids: ['a', 'b', 'c'],
    })
    expect(next.routingMode).toBe('job_group')
    expect(next.pendingAgentIds).toEqual(['a', 'b', 'c'])
  })

  it('agent_speaking_start 加入 activeSpeakerIds（不重複）', () => {
    let state = agentSessionReducer(initialSessionState, {
      type: 'agent_speaking_start',
      agent_id: 'a',
    })
    state = agentSessionReducer(state, { type: 'agent_speaking_start', agent_id: 'a' })
    expect(state.activeSpeakerIds).toEqual(['a'])
  })

  it('agent_speaking_start 支援多個 agent 同時發話（job group 情境）', () => {
    let state = agentSessionReducer(initialSessionState, {
      type: 'agent_speaking_start',
      agent_id: 'a',
    })
    state = agentSessionReducer(state, { type: 'agent_speaking_start', agent_id: 'b' })
    expect(state.activeSpeakerIds).toEqual(['a', 'b'])
  })

  it('agent_speaking_chunk 附加 agent 發言到 transcript', () => {
    const next = agentSessionReducer(initialSessionState, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '我今天很好',
      audio: 'base64data',
    })
    expect(next.transcript[0]).toMatchObject({
      kind: 'agent',
      agentId: 'a',
      text: '我今天很好',
      hasAudio: true,
    })
  })

  it('agent_speaking_chunk 文字為空時不新增 transcript 項目（修過的重複顯示 bug）', () => {
    // 一句話常被 TTS 拆成多個音訊 chunk，後端只有第一個 chunk 帶文字，
    // 其餘 chunk 的 text 會是空字串——reducer 不應該為空字串再記一筆。
    let state = agentSessionReducer(initialSessionState, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '我今天很好',
      audio: 'chunk-1',
    })
    state = agentSessionReducer(state, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '',
      audio: 'chunk-2',
    })
    state = agentSessionReducer(state, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '',
      audio: 'chunk-3',
    })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0].text).toBe('我今天很好')
  })

  it('agent_speaking_end 從 activeSpeakerIds 移除該 agent，其餘保留', () => {
    let state = { ...initialSessionState, activeSpeakerIds: ['a', 'b'] }
    state = agentSessionReducer(state, { type: 'agent_speaking_end', agent_id: 'a' })
    expect(state.activeSpeakerIds).toEqual(['b'])
  })

  it('error 設定 status 與 lastError', () => {
    const next = agentSessionReducer(initialSessionState, {
      type: 'error',
      message: '連線失敗',
    })
    expect(next.status).toBe('error')
    expect(next.lastError).toBe('連線失敗')
  })

  it('disconnected 重置 status 與 activeSpeakerIds', () => {
    const state = { ...initialSessionState, status: 'ready', activeSpeakerIds: ['a'] }
    const next = agentSessionReducer(state, { type: 'disconnected' })
    expect(next.status).toBe('idle')
    expect(next.activeSpeakerIds).toEqual([])
  })

  it('未知 action type 回傳原本 state（不變）', () => {
    const next = agentSessionReducer(initialSessionState, { type: 'unknown_action' })
    expect(next).toBe(initialSessionState)
  })

  it('完整流程：routing_decision(handoff) → speaking_start → chunk → speaking_end', () => {
    let state = initialSessionState
    state = agentSessionReducer(state, {
      type: 'routing_decision',
      mode: 'handoff',
      agent_ids: ['a'],
    })
    state = agentSessionReducer(state, { type: 'agent_speaking_start', agent_id: 'a' })
    state = agentSessionReducer(state, {
      type: 'agent_speaking_chunk',
      agent_id: 'a',
      text: '你好',
    })
    state = agentSessionReducer(state, { type: 'agent_speaking_end', agent_id: 'a' })

    expect(state.routingMode).toBe('handoff')
    expect(state.activeSpeakerIds).toEqual([])
    expect(state.transcript).toHaveLength(1)
  })
})
