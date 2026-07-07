/**
 * browserTts.test.js — 驗證瀏覽器 TTS 輔助工具的純邏輯部分
 *
 * 只測不依賴 window.speechSynthesis 的部分（voice 選擇、語調微調、中文語音
 * 過濾），因為 vitest/jsdom 環境沒有真正的 Web Speech API，
 * speakWithBrowserTts() 本身留給實機瀏覽器驗證。
 */

import { describe, it, expect } from 'vitest'
import {
  pickVoiceIndexForAgent,
  pickUtteranceTuningForAgent,
  preferChineseVoices,
  isBrowserTtsSupported,
} from '../utils/browserTts'

describe('pickVoiceIndexForAgent', () => {
  it('voiceCount 為 0 或未提供時回傳 -1', () => {
    expect(pickVoiceIndexForAgent('agent-a', 0)).toBe(-1)
    expect(pickVoiceIndexForAgent('agent-a')).toBe(-1)
  })

  it('同一個 agent_id 永遠選到同一個 index', () => {
    const first = pickVoiceIndexForAgent('agent-a', 5)
    const second = pickVoiceIndexForAgent('agent-a', 5)
    expect(first).toBe(second)
  })

  it('回傳的 index 落在 [0, voiceCount) 範圍內', () => {
    for (const agentId of ['agent-a', 'agent-b', 'agent-c', 'some-other-id']) {
      const idx = pickVoiceIndexForAgent(agentId, 3)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(3)
    }
  })

  it('不同 agent_id 在語音數量足夠時傾向選到不同 index（至少有區隔，不全部一樣）', () => {
    const indices = new Set(
      ['agent-a', 'agent-b', 'agent-c'].map((id) => pickVoiceIndexForAgent(id, 10)),
    )
    expect(indices.size).toBeGreaterThan(1)
  })
})

describe('pickUtteranceTuningForAgent', () => {
  it('回傳 pitch/rate 皆為合理範圍內的數字，且同一 agent 穩定不變', () => {
    const a1 = pickUtteranceTuningForAgent('agent-a')
    const a2 = pickUtteranceTuningForAgent('agent-a')
    expect(a1).toEqual(a2)
    expect(a1.pitch).toBeGreaterThan(0)
    expect(a1.rate).toBeGreaterThan(0)
  })
})

describe('preferChineseVoices', () => {
  it('優先回傳 zh-TW 語音', () => {
    const voices = [
      { lang: 'en-US' },
      { lang: 'zh-CN' },
      { lang: 'zh-TW' },
    ]
    const result = preferChineseVoices(voices)
    expect(result).toEqual([{ lang: 'zh-TW' }])
  })

  it('沒有 zh-TW 時 fallback 到其他 zh 語音', () => {
    const voices = [{ lang: 'en-US' }, { lang: 'zh-CN' }]
    const result = preferChineseVoices(voices)
    expect(result).toEqual([{ lang: 'zh-CN' }])
  })

  it('完全沒有中文語音時回傳原始清單', () => {
    const voices = [{ lang: 'en-US' }, { lang: 'ja-JP' }]
    const result = preferChineseVoices(voices)
    expect(result).toEqual(voices)
  })
})

describe('isBrowserTtsSupported', () => {
  it('在測試環境（jsdom 沒有 speechSynthesis）下回傳 false', () => {
    expect(isBrowserTtsSupported()).toBe(false)
  })
})
