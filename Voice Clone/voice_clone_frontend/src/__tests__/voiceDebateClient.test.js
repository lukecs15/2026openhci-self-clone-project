/**
 * voiceDebateClient.test.js — 驗證辯論模式 WebSocket 訊息組裝函式
 */

import { describe, it, expect } from 'vitest'
import {
  DEBATE_TOPIC_OPTIONS,
  buildInitDebateSessionMessage,
  buildPauseDebateMessage,
  buildUserInterveneMessage,
  buildTurnPlayedMessage,
  buildEndDebateSessionMessage,
} from '../api/voiceDebateClient'

const FAKE_AGENTS = [
  { agent_id: 'agent-a', display_name: '小明' },
  { agent_id: 'agent-b', display_name: '小華' },
]

describe('DEBATE_TOPIC_OPTIONS', () => {
  it('剛好有 3 個主題，且每個都有 topic_id 與 title', () => {
    expect(DEBATE_TOPIC_OPTIONS).toHaveLength(3)
    DEBATE_TOPIC_OPTIONS.forEach((topic) => {
      expect(topic.topic_id).toBeTruthy()
      expect(topic.title).toBeTruthy()
    })
  })

  it('topic_id 沒有重複', () => {
    const ids = DEBATE_TOPIC_OPTIONS.map((t) => t.topic_id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('buildInitDebateSessionMessage', () => {
  it('組出含 topic_id 與 agents 的 init_debate_session 訊息', () => {
    const message = buildInitDebateSessionMessage('failure', FAKE_AGENTS)
    expect(message).toEqual({
      type: 'init_debate_session',
      topic_id: 'failure',
      agents: FAKE_AGENTS,
    })
  })
})

describe('buildPauseDebateMessage', () => {
  it('組出 pause_debate 訊息', () => {
    expect(buildPauseDebateMessage()).toEqual({ type: 'pause_debate' })
  })
})

describe('buildUserInterveneMessage', () => {
  it('組出含 text 的 user_intervene 訊息', () => {
    expect(buildUserInterveneMessage('我想問一下')).toEqual({
      type: 'user_intervene',
      text: '我想問一下',
    })
  })
})

describe('buildTurnPlayedMessage', () => {
  it('組出含 agent_id 的 turn_played 訊息', () => {
    expect(buildTurnPlayedMessage('agent-a')).toEqual({
      type: 'turn_played',
      agent_id: 'agent-a',
    })
  })
})

describe('buildEndDebateSessionMessage', () => {
  it('組出 end_session 訊息', () => {
    expect(buildEndDebateSessionMessage()).toEqual({ type: 'end_session' })
  })
})
