/**
 * sendQueue.test.js — 驗證 WebSocket 訊息佇列邏輯（修過的 init_session 遺失 bug）
 */

import { describe, it, expect } from 'vitest'
import { createSendQueue } from '../utils/sendQueue'

describe('createSendQueue', () => {
  it('push 後 size 增加，drain 後清空並依序回傳', () => {
    const queue = createSendQueue()
    queue.push({ type: 'init_session' })
    queue.push({ type: 'user_text', text: 'hi' })

    expect(queue.size()).toBe(2)

    const drained = queue.drain()
    expect(drained).toEqual([{ type: 'init_session' }, { type: 'user_text', text: 'hi' }])
    expect(queue.size()).toBe(0)
  })

  it('drain 後再 drain 一次回傳空陣列（不會重複送出）', () => {
    const queue = createSendQueue()
    queue.push({ type: 'init_session' })
    queue.drain()

    expect(queue.drain()).toEqual([])
  })

  it('模擬 connect() 後立刻呼叫 initSession 但連線還沒 OPEN 的情境', () => {
    const queue = createSendQueue()
    let readyState = 0 // WebSocket.CONNECTING

    // safeSend 邏輯：還沒 OPEN 就先進佇列
    const safeSend = (payload) => {
      if (readyState === 1) {
        return payload // 模擬「立刻送出」
      }
      queue.push(payload)
      return null
    }

    const result = safeSend({ type: 'init_session', agents: [] })
    expect(result).toBeNull()
    expect(queue.size()).toBe(1)

    // 連線變成 OPEN 後（模擬 onopen），drain 佇列送出
    readyState = 1
    const pending = queue.drain()
    expect(pending).toEqual([{ type: 'init_session', agents: [] }])
  })
})
