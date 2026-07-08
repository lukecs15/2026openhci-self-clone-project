/**
 * emotionSignal.test.js — 驗證單輪文字情緒訊號分析（analyzeTurnEmotion）
 */

import { describe, it, expect } from 'vitest'
import { analyzeTurnEmotion } from '../utils/emotionSignal'

describe('analyzeTurnEmotion', () => {
  it('空字串／undefined／null 都回傳全部為 0 的偏移量，不會拋例外', () => {
    const zero = { frequencyDelta: 0, amplitudeDelta: 0, shapeDelta: 0, hueDelta: 0 }
    expect(analyzeTurnEmotion('')).toEqual(zero)
    expect(analyzeTurnEmotion(undefined)).toEqual(zero)
    expect(analyzeTurnEmotion(null)).toEqual(zero)
  })

  it('同樣的文字每次呼叫都得到完全相同的結果（決定性、不呼叫 LLM）', () => {
    const text = '真的嗎！！我好開心，謝謝你！'
    expect(analyzeTurnEmotion(text)).toEqual(analyzeTurnEmotion(text))
  })

  it('平淡沒有任何標點/關鍵字的文字，所有偏移量都是 0', () => {
    const result = analyzeTurnEmotion('今天天氣普通')
    expect(result).toEqual({ frequencyDelta: 0, amplitudeDelta: 0, shapeDelta: 0, hueDelta: 0 })
  })

  it('驚嘆號越多，frequencyDelta 跟 amplitudeDelta 越大（興奮的語氣）', () => {
    const one = analyzeTurnEmotion('太好了！')
    const three = analyzeTurnEmotion('太好了！！！')
    expect(three.frequencyDelta).toBeGreaterThan(one.frequencyDelta)
    expect(three.amplitudeDelta).toBeGreaterThan(one.amplitudeDelta)
  })

  it('驚嘆號次數的影響力會封頂（超過 3 次跟剛好 3 次結果一樣，不會線性暴走）', () => {
    const three = analyzeTurnEmotion('好！！！')
    const six = analyzeTurnEmotion('好！！！！！！')
    expect(six).toEqual(three)
  })

  it('問號會提高 frequencyDelta 跟 shapeDelta（追問的語氣讓波形更複雜不規則）', () => {
    const plain = analyzeTurnEmotion('這是什麼')
    const question = analyzeTurnEmotion('這是什麼？')
    expect(question.frequencyDelta).toBeGreaterThan(plain.frequencyDelta)
    expect(question.shapeDelta).toBeGreaterThan(plain.shapeDelta)
  })

  it('猶豫語氣（... 、 …、呃、嗯）會降低 frequencyDelta 跟 amplitudeDelta（步調變慢、稍微收斂）', () => {
    const plain = analyzeTurnEmotion('我覺得可以這樣做')
    const hesitant = analyzeTurnEmotion('呃…我覺得…可以這樣做吧')
    expect(hesitant.frequencyDelta).toBeLessThan(plain.frequencyDelta)
    expect(hesitant.amplitudeDelta).toBeLessThan(plain.amplitudeDelta)
  })

  it('溫暖關鍵字會提高 hueDelta、降低 shapeDelta（語氣平滑規律、色相往暖色偏）', () => {
    const plain = analyzeTurnEmotion('我知道了')
    const warm = analyzeTurnEmotion('謝謝你，有你陪我真的很開心，很溫暖')
    expect(warm.hueDelta).toBeGreaterThan(plain.hueDelta)
    expect(warm.shapeDelta).toBeLessThan(plain.shapeDelta)
  })

  it('緊張關鍵字會提高 frequencyDelta/amplitudeDelta/shapeDelta、降低 hueDelta', () => {
    const plain = analyzeTurnEmotion('我知道了')
    const tense = analyzeTurnEmotion('我好焦慮，好緊張，壓力好大，覺得好痛苦')
    expect(tense.frequencyDelta).toBeGreaterThan(plain.frequencyDelta)
    expect(tense.amplitudeDelta).toBeGreaterThan(plain.amplitudeDelta)
    expect(tense.shapeDelta).toBeGreaterThan(plain.shapeDelta)
    expect(tense.hueDelta).toBeLessThan(plain.hueDelta)
  })

  it('關鍵字出現次數也會封頂（不會因為同一個關鍵字複誦很多次而暴走）', () => {
    const twice = analyzeTurnEmotion('謝謝 謝謝')
    // 同一個關鍵字重複出現，countKeywords 用 includes 只算「有沒有出現」，
    // 不是出現次數，所以應該跟只出現一次時的結果一樣。
    const once = analyzeTurnEmotion('謝謝')
    expect(twice).toEqual(once)
  })

  it('多種特徵同時出現時，偏移量會加總（不是互相取代）', () => {
    const excitedOnly = analyzeTurnEmotion('太好了！')
    const warmOnly = analyzeTurnEmotion('謝謝你')
    const combined = analyzeTurnEmotion('太好了！謝謝你')
    expect(combined.frequencyDelta).toBeCloseTo(excitedOnly.frequencyDelta, 5)
    expect(combined.hueDelta).toBeCloseTo(warmOnly.hueDelta, 5)
  })
})
