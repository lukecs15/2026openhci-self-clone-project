/**
 * bigFiveQuestions.js — Big Five 問卷題目（正式題庫，法庭審訊主題）
 *
 * 內容逐字從使用者提供的設計稿 inner-court-survey-fix8.html 搬過來
 * （BFI-2-XS 15 題，法庭風改寫，每向度 3 題）。設計稿裡每題的 `dim` 用
 * 單字母（E/A/C/N/O），這裡轉換成後端 voice_clone_backend/services/
 * personality_mapping.py 的 TRAIT_ORDER 使用的完整向度名稱
 * （openness／conscientiousness／extraversion／agreeableness／
 * neuroticism），`reverse` 欄位直接沿用（設計稿註明反向計分題是
 * 1/3/7/8/10/14 題，這裡逐題核對過都一致）。
 *
 * 計分邏輯（store/questionnaireFlow.js）不需要因為換題庫而修改：只依賴
 * `{ id, trait, reverse }` 這個形狀，跟題目文字本身完全解耦，這也是當初
 * 佔位題庫刻意這樣設計的原因（見該檔案開頭說明）。
 */

const DIM_TO_TRAIT = {
  E: 'extraversion',
  A: 'agreeableness',
  C: 'conscientiousness',
  N: 'neuroticism',
  O: 'openness',
}

export const TRAIT_LABELS = {
  openness: '開放性',
  conscientiousness: '盡責性',
  extraversion: '外向性',
  agreeableness: '親和性',
  neuroticism: '負向情緒',
}

// 對應設計稿的 SCALE（"絕對不是我" ~ "這就是我"），沿用 1~5 分的 Likert
// 量表值，跟計分邏輯（(6 - value) 反向計分）完全相容。
export const LIKERT_OPTIONS = [
  { value: 1, label: '絕對不是我' },
  { value: 2, label: '偶爾符合' },
  { value: 3, label: '保持中立' },
  { value: 4, label: '滿符合的' },
  { value: 5, label: '這就是我' },
]

// BFI-2-XS 15 題・法庭風改寫（dim = 向度；reverse = 反向計分）。標點逐字
// 沿用設計稿風格：句中逗號/冒號用半形，頓號、句號維持全形（先前這裡誤用了
// 全形逗號，跟設計稿原文核對後在這裡統一改回半形，見 OnboardingFlow.jsx
// 同一次修正的說明）。
const RAW_QUESTIONS = [
  { dim: 'E', reverse: true, text: '據報,你在多數場合傾向保持安靜——彷彿隨身開著靜音模式。' },
  { dim: 'A', reverse: false, text: '有目擊者指出,你有一顆豆腐做的心,見不得別人受苦。' },
  { dim: 'C', reverse: true, text: '卷宗顯示,你經常丟三落四——東西放哪、事情做到哪,常常自己也說不清。' },
  { dim: 'N', reverse: false, text: '你被指控:凡事憂慮、樣樣操心,連還沒發生的事也預先擔心。' },
  { dim: 'O', reverse: false, text: '證據顯示,你會被藝術、音樂或文學深深吸引,久久不能自拔。' },
  { dim: 'E', reverse: false, text: '多方證詞指出,你習慣主導場面——自然而然,就成了發號施令的那個人。' },
  { dim: 'A', reverse: true, text: '有人指控,你偶爾對人粗魯、不耐煩,話說出口才想到會傷人。' },
  { dim: 'C', reverse: true, text: '紀錄在案:面對該開始的事,你總是拖延,遲遲無法動手。' },
  { dim: 'N', reverse: false, text: '你被指控:時常陷入低潮,心情像蒙上一層藍色的霧。' },
  { dim: 'O', reverse: true, text: '據查,你對抽象的概念興趣缺缺——一談理論,就想離席。' },
  { dim: 'E', reverse: false, text: '證人描述,你精力充沛,走到哪裡都帶著一股用不完的電。' },
  { dim: 'A', reverse: false, text: '卷宗記載,你傾向相信人性本善,總是先把人往好處想。' },
  { dim: 'C', reverse: false, text: '多方證實,你是可靠的人——答應的事,從不落空。' },
  { dim: 'N', reverse: true, text: '據觀察,你情緒穩定,不輕易被激怒或動搖。' },
  { dim: 'O', reverse: false, text: '你被指控:想法天馬行空,總能想出別人沒想過的點子。' },
]

export const BIG_FIVE_QUESTIONS = RAW_QUESTIONS.map((q, i) => ({
  id: `q${i + 1}`,
  trait: DIM_TO_TRAIT[q.dim],
  dim: q.dim,
  reverse: q.reverse,
  text: q.text,
}))
