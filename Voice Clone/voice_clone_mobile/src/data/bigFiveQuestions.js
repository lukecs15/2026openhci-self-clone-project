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

// BFI-2-XS 標準 1~5 Likert 量表（Disagree strongly ~ Agree strongly 中譯），
// 分值不變，跟計分邏輯（(6 - value) 反向計分）完全相容。
export const LIKERT_OPTIONS = [
  { value: 1, label: '非常不同意' },
  { value: 2, label: '有點不同意' },
  { value: 3, label: '中立,沒意見' },
  { value: 4, label: '有點同意' },
  { value: 5, label: '非常同意' },
]

// BFI-2-XS 15 題・標準中譯（Soto & John, 2017；棄用先前的法庭風改寫，
// 直接翻譯原題）。題序、向度（dim）與反向計分（reverse：1/3/7/8/10/14 題）
// 完全依照原量表的 Scoring Key：
//   Extraversion: 1R, 6, 11／Agreeableness: 2, 7R, 12／
//   Conscientiousness: 3R, 8R, 13／Negative Emotionality: 4, 9, 14R／
//   Open-Mindedness: 5, 10R, 15
// 每題以原文「I am someone who...」的語感翻成「我是一個…的人」的完整敘述。
const RAW_QUESTIONS = [
  { dim: 'E', reverse: true, text: '我是一個傾向安靜、不多話的人。' },
  { dim: 'A', reverse: false, text: '我富有同情心,是個心腸軟的人。' },
  { dim: 'C', reverse: true, text: '我做事情傾向雜亂無章、缺乏條理。' },
  { dim: 'N', reverse: false, text: '我經常為許多事情感到擔憂。' },
  { dim: 'O', reverse: false, text: '我深深著迷於藝術、音樂或文學。' },
  { dim: 'E', reverse: false, text: '我具有主導性,常扮演領導者的角色。' },
  { dim: 'A', reverse: true, text: '我有時會對別人顯得粗魯無禮。' },
  { dim: 'C', reverse: true, text: '我很難開始著手去做該做的事。' },
  { dim: 'N', reverse: false, text: '我容易感到沮喪、心情低落。' },
  { dim: 'O', reverse: true, text: '我對抽象的概念沒有什麼興趣。' },
  { dim: 'E', reverse: false, text: '我精力充沛、活力十足。' },
  { dim: 'A', reverse: false, text: '我傾向把別人往好處想。' },
  { dim: 'C', reverse: false, text: '我很可靠,別人總是可以信賴我。' },
  { dim: 'N', reverse: true, text: '我情緒穩定,不容易心煩意亂。' },
  { dim: 'O', reverse: false, text: '我有原創性,常能想出新的點子。' },
]

export const BIG_FIVE_QUESTIONS = RAW_QUESTIONS.map((q, i) => ({
  id: `q${i + 1}`,
  trait: DIM_TO_TRAIT[q.dim],
  dim: q.dim,
  reverse: q.reverse,
  text: q.text,
}))
