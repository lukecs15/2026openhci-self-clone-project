/**
 * emotionSignal.js — 從單輪 agent 回覆文字粗略估計「情緒訊號」
 *
 * 需求：對話過程中，波形要因為 agent 回覆的情緒而動態調整（改變波的
 * 形狀），不是只有「說話中/沒說話」兩種狀態。跟 waveformSignature.js
 * 「初始波形刻意不分析 persona 文字」是不同層次的東西：
 *   - persona 簽章（waveformSignature.js）：決定「這個角色大致是什麼
 *     樣子」，一次性、目前刻意用預設原型，之後會改成問卷。
 *   - 情緒訊號（這個檔案）：決定「這句話當下的情緒起伏」，對話過程中
 *     每輪都會重新算，是很輕量的文字特徵評分，不呼叫 LLM。
 *
 * 回傳的是「相對於基準波形的偏移量」（delta），不是完整的參數組——呼叫端
 * （waveformSignature.js 的 applyEmotionSignal()）會把這些偏移疊加在
 * persona 基準波形上，疊加後仍然會 clamp 在合理範圍內，確保「以角色波形
 * 為主軸，情緒只是讓波形有感的微調」，不會整個變成另一種長相。
 *
 * 每種特徵出現次數的影響力都用 Math.min(count, 3) 封頂，避免長文字因為
 * 關鍵字/標點重複出現太多次而讓偏移量線性暴走。
 */

const EXCITED_PATTERN = /[！!]/g
const QUESTION_PATTERN = /[？?]/g
const HESITATION_PATTERN = /(\.\.\.|…|呃|嗯)/g

// 關鍵字清單刻意簡短、涵蓋常見情境即可，不追求完整的情感詞典。
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
 * @param {string} text 這一輪（或目前累積到的這一句）agent 說的話
 * @returns {{ frequencyDelta:number, amplitudeDelta:number, shapeDelta:number, hueDelta:number }}
 */
export function analyzeTurnEmotion(text) {
  if (!text) {
    return { frequencyDelta: 0, amplitudeDelta: 0, shapeDelta: 0, hueDelta: 0 }
  }

  const excited = countMatches(text, EXCITED_PATTERN)
  const questioning = countMatches(text, QUESTION_PATTERN)
  const hesitant = countMatches(text, HESITATION_PATTERN)
  const warm = countKeywords(text, WARM_KEYWORDS)
  const tense = countKeywords(text, TENSE_KEYWORDS)

  // 頻率：興奮/追問/緊張的語氣讓思緒「跳得比較快」，猶豫的語氣讓步調變慢。
  const frequencyDelta = excited * 0.25 + questioning * 0.1 - hesitant * 0.15 + tense * 0.15

  // 振幅：情緒起伏越大（興奮或緊張）振幅越大，猶豫時稍微收斂。
  const amplitudeDelta = excited * 0.05 + tense * 0.04 - hesitant * 0.03

  // 波形：疑問/緊張讓波形更複雜不規則，溫暖的語氣讓波形更平滑規律。
  const shapeDelta = questioning * 0.08 + tense * 0.1 - warm * 0.08

  // 顏色：溫暖語氣往暖色調偏，緊張語氣往外偏移（不特別指定方向，只是
  // 讓色相有感地變化，數值範圍刻意不大，避免整個變成完全不同的顏色）。
  const hueDelta = warm * 12 - tense * 15

  return { frequencyDelta, amplitudeDelta, shapeDelta, hueDelta }
}
