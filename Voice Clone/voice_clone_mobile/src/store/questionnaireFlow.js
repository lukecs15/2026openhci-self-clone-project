/**
 * questionnaireFlow.js — Big Five 答案 → 五向度分數（純函式，跟 React/DOM 無關）
 *
 * 對應後端 voice_clone_backend/models/schemas.py 的 BigFiveScores：每個向度
 * 換算成 0~100 的分數（50 為中性），POST /api/onboarding-sessions/{id}/link
 * 時直接把這裡算出來的物件當 big_five 欄位送出（見 api/onboardingClient.js）。
 *
 * 計分規則（心理測驗常見的 Likert 量表計分法）：
 *   1. 每一題的原始作答是 1~5（見 data/bigFiveQuestions.js 的 LIKERT_OPTIONS）。
 *   2. reverse（反向計分）題目先用 (6 - value) 轉換，再跟正向題一起平均——
 *      同一個向度不管題目是正向還是反向敘述，換算後都是「分數越高代表這個
 *      向度的傾向越強」。
 *   3. 同一個向度的所有題目取平均（1~5），再線性映射到 0~100：
 *      (avg - 1) / 4 * 100。
 *   4. 使用者若有題目沒作答（跳過），該題不計入平均，不會讓其他已作答的
 *      題目失真；如果整個向度一題都沒答，用中性值 50（呼應後端
 *      personality_mapping.py 對缺漏向度的預設處理，前後端行為一致）。
 *
 * 刻意把這裡的計分邏輯跟 data/bigFiveQuestions.js 的題目內容分開：之後題庫
 * 換成正式版本時，只要保持每一題 `{ id, trait, reverse }` 的形狀，這裡完全
 * 不需要改。
 */

export const TRAIT_ORDER = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism']

const LIKERT_MIN = 1
const LIKERT_MAX = 5
const NEUTRAL_SCORE = 50

function toDirectionalValue(question, rawValue) {
  return question.reverse ? LIKERT_MAX + LIKERT_MIN - rawValue : rawValue
}

function scaleAverageTo100(average) {
  return ((average - LIKERT_MIN) / (LIKERT_MAX - LIKERT_MIN)) * 100
}

/**
 * @param {Array<{id:string, trait:string, reverse:boolean}>} questions
 * @param {Record<string, number>} answers 題目 id -> 1~5 的作答（未作答的題目不需要出現在這裡）
 * @returns {Record<string, number>} 五個向度各自的 0~100 分數
 */
export function computeBigFiveScores(questions, answers) {
  const sums = {}
  const counts = {}

  questions.forEach((question) => {
    const rawValue = answers[question.id]
    if (rawValue === undefined || rawValue === null) return

    const directional = toDirectionalValue(question, rawValue)
    sums[question.trait] = (sums[question.trait] || 0) + directional
    counts[question.trait] = (counts[question.trait] || 0) + 1
  })

  const scores = {}
  TRAIT_ORDER.forEach((trait) => {
    if (!counts[trait]) {
      scores[trait] = NEUTRAL_SCORE
      return
    }
    const average = sums[trait] / counts[trait]
    scores[trait] = Math.round(scaleAverageTo100(average) * 10) / 10 // 保留一位小數，避免浮點數尾巴
  })

  return scores
}

/** 目前已作答的題數（用來驅動進度條 / 判斷是否可以進到下一步）。 */
export function countAnswered(answers) {
  return Object.values(answers).filter((v) => v !== undefined && v !== null).length
}

/** 是否所有題目都已作答（下一步「錄音」按鈕的 disabled 判斷）。 */
export function isQuestionnaireComplete(questions, answers) {
  return questions.every((q) => answers[q.id] !== undefined && answers[q.id] !== null)
}
