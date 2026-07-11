/**
 * bigFiveQuestions.js — Big Five 問卷題目（佔位版本，等使用者提供實際題庫）
 *
 * 使用者確認之後會提供正式的題目/文案，這裡先放一份結構正確、可以完整跑通
 * 「填答 → 計分 → 上傳」整條流程的佔位題庫，方便先測試功能。之後只需要
 * 替換這個檔案的 `BIG_FIVE_QUESTIONS` 陣列內容（保持相同的
 * `{ id, trait, reverse, text }` 形狀），不需要改 store/questionnaireFlow.js
 * 的計分邏輯或任何頁面元件——計分邏輯只依賴 `trait` / `reverse` 欄位，
 * 跟題目文字本身完全解耦。
 *
 * 每題是 1~5 的 Likert 量表（見 LIKERT_OPTIONS），`reverse: true` 代表這題
 * 是反向計分（同意程度越高，該向度分數反而越低），計分時會用 (6 - value)
 * 換算，這是心理測驗量表常見的設計（避免使用者不假思索地一路都選「同意」）。
 *
 * trait 的五個值對應後端 voice_clone_backend/services/personality_mapping.py
 * 的 TRAIT_ORDER：openness（開放性）／conscientiousness（盡責性）／
 * extraversion（外向性）／agreeableness（親和性）／neuroticism（負面情緒）。
 */

export const LIKERT_OPTIONS = [
  { value: 1, label: '非常不同意' },
  { value: 2, label: '不同意' },
  { value: 3, label: '普通' },
  { value: 4, label: '同意' },
  { value: 5, label: '非常同意' },
]

export const TRAIT_LABELS = {
  openness: '開放性',
  conscientiousness: '盡責性',
  extraversion: '外向性',
  agreeableness: '親和性',
  neuroticism: '負面情緒',
}

// 佔位題庫：每個向度 4 題（2 正向 + 2 反向），共 20 題。
export const BIG_FIVE_QUESTIONS = [
  // 開放性
  { id: 'o1', trait: 'openness', reverse: false, text: '我喜歡嘗試沒做過的新事物。' },
  { id: 'o2', trait: 'openness', reverse: false, text: '我對新的想法、藝術或知識常常感到好奇。' },
  { id: 'o3', trait: 'openness', reverse: true, text: '比起新奇的做法，我更偏好熟悉、固定的方式。' },
  { id: 'o4', trait: 'openness', reverse: true, text: '天馬行空的想法對我來說沒什麼吸引力。' },

  // 盡責性
  { id: 'c1', trait: 'conscientiousness', reverse: false, text: '我做事情通常會事先規劃、按部就班。' },
  { id: 'c2', trait: 'conscientiousness', reverse: false, text: '答應別人的事，我會盡力準時完成。' },
  { id: 'c3', trait: 'conscientiousness', reverse: true, text: '我常常臨時才開始準備，沒有太多計畫。' },
  { id: 'c4', trait: 'conscientiousness', reverse: true, text: '生活中的雜物、進度我不太在意整理與追蹤。' },

  // 外向性
  { id: 'e1', trait: 'extraversion', reverse: false, text: '在團體場合中，我通常會主動發言、帶動氣氛。' },
  { id: 'e2', trait: 'extraversion', reverse: false, text: '認識新朋友、參加社交活動讓我感到有活力。' },
  { id: 'e3', trait: 'extraversion', reverse: true, text: '比起熱鬧的場合，我更喜歡安靜獨處。' },
  { id: 'e4', trait: 'extraversion', reverse: true, text: '在不熟的人面前，我通常話不多。' },

  // 親和性
  { id: 'a1', trait: 'agreeableness', reverse: false, text: '我很容易同理別人的感受，願意配合他人。' },
  { id: 'a2', trait: 'agreeableness', reverse: false, text: '與人相處時，我傾向以和為貴、避免衝突。' },
  { id: 'a3', trait: 'agreeableness', reverse: true, text: '就算會讓氣氛尷尬，我也會直接說出不同意見。' },
  { id: 'a4', trait: 'agreeableness', reverse: true, text: '我比較重視自己的立場，不太會為了別人而讓步。' },

  // 負面情緒
  { id: 'n1', trait: 'neuroticism', reverse: false, text: '遇到壓力或變化時，我容易感到焦慮不安。' },
  { id: 'n2', trait: 'neuroticism', reverse: false, text: '我常常反覆思考已經發生的事，難以放下。' },
  { id: 'n3', trait: 'neuroticism', reverse: true, text: '即使遇到突發狀況，我通常也能保持冷靜。' },
  { id: 'n4', trait: 'neuroticism', reverse: true, text: '整體來說，我的情緒相當穩定，不容易被影響。' },
]
