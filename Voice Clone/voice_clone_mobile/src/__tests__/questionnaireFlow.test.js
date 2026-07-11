/**
 * questionnaireFlow.test.js — 驗證 Big Five 答案 → 五向度分數的計分邏輯
 */

import { describe, it, expect } from 'vitest'
import {
  computeBigFiveScores,
  countAnswered,
  isQuestionnaireComplete,
  TRAIT_ORDER,
} from '../store/questionnaireFlow'

const QUESTIONS = [
  { id: 'o1', trait: 'openness', reverse: false },
  { id: 'o2', trait: 'openness', reverse: true },
  { id: 'c1', trait: 'conscientiousness', reverse: false },
  { id: 'e1', trait: 'extraversion', reverse: false },
  { id: 'a1', trait: 'agreeableness', reverse: false },
  { id: 'n1', trait: 'neuroticism', reverse: false },
]

describe('computeBigFiveScores', () => {
  it('全部選最高分（5）時，正向題的向度分數應該是 100', () => {
    const answers = { o1: 5, c1: 5, e1: 5, a1: 5, n1: 5 }
    const scores = computeBigFiveScores(QUESTIONS, answers)
    expect(scores.conscientiousness).toBe(100)
    expect(scores.extraversion).toBe(100)
    expect(scores.agreeableness).toBe(100)
    expect(scores.neuroticism).toBe(100)
  })

  it('全部選最低分（1）時，正向題的向度分數應該是 0', () => {
    const answers = { c1: 1, e1: 1, a1: 1, n1: 1 }
    const scores = computeBigFiveScores(QUESTIONS, answers)
    expect(scores.conscientiousness).toBe(0)
    expect(scores.extraversion).toBe(0)
    expect(scores.agreeableness).toBe(0)
    expect(scores.neuroticism).toBe(0)
  })

  it('反向題（reverse: true）選最高分（5）時，應該換算成該向度的低分', () => {
    // o2 是反向題，選 5 分（非常同意）代表這個向度傾向低
    const answers = { o2: 5 }
    const scores = computeBigFiveScores(QUESTIONS, answers)
    expect(scores.openness).toBe(0)
  })

  it('反向題選最低分（1）時，應該換算成該向度的高分', () => {
    const answers = { o2: 1 }
    const scores = computeBigFiveScores(QUESTIONS, answers)
    expect(scores.openness).toBe(100)
  })

  it('同一向度的正向題與反向題會一起平均（換算方向一致後）', () => {
    // o1（正向）選 5、o2（反向）選 5 → 換算後分別是 5 分、1 分，平均 3 分 → 50
    const answers = { o1: 5, o2: 5 }
    const scores = computeBigFiveScores(QUESTIONS, answers)
    expect(scores.openness).toBe(50)
  })

  it('選 3（普通）時分數應該落在中性值 50 附近', () => {
    const answers = { c1: 3, e1: 3, a1: 3, n1: 3 }
    const scores = computeBigFiveScores(QUESTIONS, answers)
    expect(scores.conscientiousness).toBe(50)
    expect(scores.extraversion).toBe(50)
  })

  it('完全沒有作答的向度，預設用中性值 50（跟後端 personality_mapping.py 的缺漏處理一致）', () => {
    const scores = computeBigFiveScores(QUESTIONS, {})
    TRAIT_ORDER.forEach((trait) => {
      expect(scores[trait]).toBe(50)
    })
  })

  it('回傳的物件涵蓋全部五個向度，即使題庫裡沒有那個向度的題目', () => {
    const scores = computeBigFiveScores([{ id: 'o1', trait: 'openness', reverse: false }], { o1: 5 })
    expect(Object.keys(scores).sort()).toEqual([...TRAIT_ORDER].sort())
  })

  it('未作答的題目（值是 undefined）不會被計入平均', () => {
    // o1 未作答，只有 o2（反向）回答 1 分 → 換算成 5 分 → 100
    const answers = { o2: 1 }
    const scores = computeBigFiveScores(QUESTIONS, answers)
    expect(scores.openness).toBe(100)
  })
})

describe('countAnswered', () => {
  it('計算已作答的題目數量', () => {
    expect(countAnswered({ o1: 5, o2: 3 })).toBe(2)
  })

  it('undefined/null 的值不計入', () => {
    expect(countAnswered({ o1: 5, o2: undefined, o3: null })).toBe(1)
  })

  it('空物件回傳 0', () => {
    expect(countAnswered({})).toBe(0)
  })
})

describe('isQuestionnaireComplete', () => {
  it('全部題目都作答時回傳 true', () => {
    const answers = { o1: 5, o2: 3, c1: 4, e1: 2, a1: 5, n1: 1 }
    expect(isQuestionnaireComplete(QUESTIONS, answers)).toBe(true)
  })

  it('還有題目沒作答時回傳 false', () => {
    const answers = { o1: 5, o2: 3 }
    expect(isQuestionnaireComplete(QUESTIONS, answers)).toBe(false)
  })

  it('空題庫視為已完成（不會卡住流程）', () => {
    expect(isQuestionnaireComplete([], {})).toBe(true)
  })
})
