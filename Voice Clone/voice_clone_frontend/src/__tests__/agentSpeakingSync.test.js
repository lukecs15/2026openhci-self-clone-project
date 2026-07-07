/**
 * agentSpeakingSync.test.js — 驗證「發話中」高亮對齊播放結束時間的邏輯
 */

import { describe, it, expect } from 'vitest'
import { waitForPlaybackToSettle } from '../utils/agentSpeakingSync'

describe('waitForPlaybackToSettle', () => {
  it('兩個佇列都是 undefined（這個 agent 這輪沒有任何東西要播）時立刻 resolve', async () => {
    await expect(waitForPlaybackToSettle(undefined, undefined)).resolves.toBeDefined()
  })

  it('只有音訊佇列時，等音訊播完才 resolve', async () => {
    let audioResolved = false
    const audioPromise = new Promise((resolve) => {
      setTimeout(() => {
        audioResolved = true
        resolve()
      }, 10)
    })

    await waitForPlaybackToSettle(audioPromise, undefined)
    expect(audioResolved).toBe(true)
  })

  it('音訊與瀏覽器 TTS 朗讀佇列都要等到播完才 resolve（等比較慢的那個）', async () => {
    let audioResolved = false
    let speechResolved = false
    const audioPromise = new Promise((resolve) => {
      setTimeout(() => {
        audioResolved = true
        resolve()
      }, 5)
    })
    const speechPromise = new Promise((resolve) => {
      setTimeout(() => {
        speechResolved = true
        resolve()
      }, 20)
    })

    await waitForPlaybackToSettle(audioPromise, speechPromise)
    expect(audioResolved).toBe(true)
    expect(speechResolved).toBe(true)
  })
})
