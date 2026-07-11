/**
 * emotionSignal.js — 從單輪文字粗略估計「情緒訊號」
 *
 * 直接從 voice_clone_frontend/src/utils/emotionSignal.js 移植過來（純函式，
 * 兩邊行為必須完全一致）。手機端結束紀念畫面會把總結句子當 currentText
 * 傳給 WaveformAvatar，這裡負責把那句話換算成波形的情緒偏移。
 */

const EXCITED_PATTERN = /[！!]/g
const QUESTION_PATTERN = /[？?]/g
const HESITATION_PATTERN = /(\.\.\.|…|呃|嗯)/g

const WARM_KEYWORDS = ['謝謝', '開心', '溫暖', '放心', '加油', '安心', '陪你', '沒關係', '很好', '喜歡', '感謝']
const TENSE_KEYWORDS = ['難過', '生氣', '崩潰', '焦慮', '壓力', '害怕', '緊張', '糟糕', '痛苦', '失望', '委屈']

const MAX_COUNT = 3

function countMatches(text, pattern) {
  const matches = text.match(pattern)
  return matches ? Math.min(matches.length, MAX_COUNT) : 0
}

function countKeywords(text, keywords) {
  const count = keywords.reduce((total, word) => (text.includes(word) ? total + 1 : total), 0)
  return Math.min(count, MAX_COUNT)
}

/**
 * @param {string} text
 * @returns {{ frequencyDelta:number, amplitudeDelta:number, shapeDelta:number, hueDelta:number, intensityDelta:number }}
 */
export function analyzeTurnEmotion(text) {
  if (!text) {
    return { frequencyDelta: 0, amplitudeDelta: 0, shapeDelta: 0, hueDelta: 0, intensityDelta: 0 }
  }

  const excited = countMatches(text, EXCITED_PATTERN)
  const questioning = countMatches(text, QUESTION_PATTERN)
  const hesitant = countMatches(text, HESITATION_PATTERN)
  const warm = countKeywords(text, WARM_KEYWORDS)
  const tense = countKeywords(text, TENSE_KEYWORDS)

  const frequencyDelta = excited * 0.25 + questioning * 0.1 - hesitant * 0.15 + tense * 0.15
  const amplitudeDelta = excited * 0.05 + tense * 0.04 - hesitant * 0.03
  const shapeDelta = questioning * 0.08 + tense * 0.1 - warm * 0.08
  const hueDelta = warm * 12 - tense * 15
  const intensityDelta = excited * 0.12 + tense * 0.12 + warm * 0.05 - hesitant * 0.08

  return { frequencyDelta, amplitudeDelta, shapeDelta, hueDelta, intensityDelta }
}
