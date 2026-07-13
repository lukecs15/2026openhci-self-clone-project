/**
 * oceanDims.js — 法庭主題五個 OCEAN 向度的視覺設定
 *
 * 逐字從設計稿 inner-court-survey-fix8.html 搬過來（DIMS 陣列），順序依
 * OCEAN（開放 → 盡責 → 外向 → 親和 → 負向情緒，由上到下畫在審訊畫面的五
 * 條波形帶）。`key` 用單字母對應 data/bigFiveQuestions.js 題目的 `dim`
 * 欄位；`trait` 對應後端 TRAIT_ORDER 使用的完整向度名稱，方便其他元件需要
 * 用完整名稱查表時不用自己再轉換一次。
 */

export const DIMS = [
  { key: 'O', trait: 'openness', label: '開放性', en: 'Openness', hue: 200, frequency: 0.7, amplitude: 0.32, shape: 0.6 },
  { key: 'C', trait: 'conscientiousness', label: '盡責性', en: 'Conscientiousness', hue: 255, frequency: 1.3, amplitude: 0.3, shape: 0.12 },
  { key: 'E', trait: 'extraversion', label: '外向性', en: 'Extraversion', hue: 95, frequency: 1.8, amplitude: 0.4, shape: 0.45 },
  { key: 'A', trait: 'agreeableness', label: '親和性', en: 'Agreeableness', hue: 34, frequency: 1.0, amplitude: 0.28, shape: 0.2 },
  { key: 'N', trait: 'neuroticism', label: '負向情緒', en: 'Negative Emotionality', hue: 350, frequency: 2.4, amplitude: 0.38, shape: 0.75 },
]

export const PER_DIM = 3 // BFI-2-XS：每向度 3 題

export function findDimIndexByKey(key) {
  return DIMS.findIndex((d) => d.key === key)
}
