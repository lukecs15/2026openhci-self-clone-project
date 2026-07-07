/**
 * browserTts.js — 開發用「瀏覽器端 TTS」輔助工具
 *
 * 背景：dev（1660Ti）環境下 TTS_ENGINE=mock，後端只回傳靜音的假音訊，單純
 * 用來驗證 WebSocket 協定/播放佇列的時序正確性，不是拿來「聽」的。若想在
 * 還沒接上 CosyVoice 2 之前，實際聽到每個 agent 講了什麼，可以另外用瀏覽器
 * 內建的 Web Speech API（window.speechSynthesis）把 agent_speaking_chunk
 * 事件裡的文字唸出來——這跟後端 TTS 是否 mock 完全獨立，純粹是前端「測試用
 * 朗讀」的替代方案，不會、也不應該取代 CosyVoice 2 之後的真實克隆語音。
 *
 * 設計成純函式 + 一個會碰 window.speechSynthesis 的執行函式分開：
 *   - pickVoiceIndexForAgent()：純邏輯，依 agent_id 決定用第幾個瀏覽器語音，
 *     讓多個 agent 講話時音色/語調有區隔，可以離線單元測試。
 *   - isBrowserTtsSupported() / speakWithBrowserTts()：實際呼叫瀏覽器 API，
 *     只能在有 window.speechSynthesis 的環境（瀏覽器）跑，測試環境
 *     （jsdom/vitest）不驗證這兩個函式的行為。
 */

/** 簡單字串 hash，只用來決定「選哪個語音」，不需要密碼學等級的雜湊。 */
function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash
}

/**
 * 依 agent_id 決定要用第幾個瀏覽器語音（voices 陣列的 index）。
 * 同一個 agent_id 永遠選到同一個 index（同一次對話音色一致），
 * 不同 agent 盡量選到不同 index（voiceCount > 1 時）。
 */
export function pickVoiceIndexForAgent(agentId, voiceCount) {
  if (!voiceCount || voiceCount <= 0) return -1
  return hashString(String(agentId)) % voiceCount
}

/**
 * 依 agent_id 決定額外的語調微調（pitch/rate），讓聽感上多個 agent
 * 有一點區隔，即使瀏覽器可用語音很少（例如只有 1 種中文語音）也一樣有差異。
 */
export function pickUtteranceTuningForAgent(agentId) {
  const h = hashString(String(agentId))
  const pitch = 0.85 + (h % 5) * 0.1 // 0.85 ~ 1.25
  const rate = 0.95 + ((h >> 3) % 4) * 0.05 // 0.95 ~ 1.10
  return { pitch, rate }
}

/** 優先挑中文語音（zh-TW 優先，其次 zh），找不到就回傳整份清單讓呼叫端自行 fallback。 */
export function preferChineseVoices(voices) {
  const zhTw = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('zh-tw'))
  if (zhTw.length > 0) return zhTw
  const zh = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('zh'))
  if (zh.length > 0) return zh
  return voices
}

export function isBrowserTtsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * 用瀏覽器內建 TTS 唸出一段文字，回傳 Promise（唸完或出錯都會 resolve，
 * 不丟例外中斷呼叫端的流程——這只是測試輔助功能，失敗了就安靜跳過）。
 */
export function speakWithBrowserTts(text, agentId) {
  if (!text || !isBrowserTtsSupported()) return Promise.resolve()

  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text)
    const voices = window.speechSynthesis.getVoices()
    const candidates = preferChineseVoices(voices)
    const idx = pickVoiceIndexForAgent(agentId, candidates.length)
    if (idx >= 0 && candidates[idx]) {
      utterance.voice = candidates[idx]
      utterance.lang = candidates[idx].lang
    } else {
      utterance.lang = 'zh-TW'
    }
    const { pitch, rate } = pickUtteranceTuningForAgent(agentId)
    utterance.pitch = pitch
    utterance.rate = rate
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    window.speechSynthesis.speak(utterance)
  })
}
