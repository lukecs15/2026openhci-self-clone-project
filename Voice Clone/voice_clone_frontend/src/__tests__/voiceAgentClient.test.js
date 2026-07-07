/**
 * voiceAgentClient.test.js — 驗證 buildInitSessionMessage 的 routing_strategy
 * 欄位處理邏輯（修過的 bug：見 buildInitSessionMessage 的說明）。
 */

import { describe, it, expect } from 'vitest'
import { buildInitSessionMessage } from '../api/voiceAgentClient'

const FAKE_AGENTS = [{ agent_id: 'agent-a', display_name: '小明' }]

describe('buildInitSessionMessage', () => {
  it('沒有指定 routingStrategy 時，訊息裡不應該出現 routing_strategy 欄位', () => {
    const message = buildInitSessionMessage(FAKE_AGENTS)

    expect(message).toEqual({ type: 'init_session', agents: FAKE_AGENTS })
    expect('routing_strategy' in message).toBe(false)
  })

  it('routingStrategy 傳 undefined 時效果一樣，不會出現 routing_strategy 欄位', () => {
    const message = buildInitSessionMessage(FAKE_AGENTS, undefined)
    expect('routing_strategy' in message).toBe(false)
  })

  it('明確指定 routingStrategy 時，訊息應該帶上該值', () => {
    const message = buildInitSessionMessage(FAKE_AGENTS, 'llm_decision')

    expect(message).toEqual({
      type: 'init_session',
      agents: FAKE_AGENTS,
      routing_strategy: 'llm_decision',
    })
  })

  it('JSON.stringify 沒有 routing_strategy 欄位的訊息，序列化結果也不含這個 key', () => {
    const message = buildInitSessionMessage(FAKE_AGENTS)
    const serialized = JSON.stringify(message)

    expect(serialized.includes('routing_strategy')).toBe(false)
  })
})
