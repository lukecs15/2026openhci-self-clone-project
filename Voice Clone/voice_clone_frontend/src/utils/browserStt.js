/**
 * browserStt.js — 開發用「瀏覽器端 STT」輔助工具
 *
 * 背景：STT_PRIMARY_ENGINE/STT_FALLBACK_ENGINE 設成 mock 時，後端的
 * MockSTTEngine 不管你實際說了什麼，永遠回傳固定的 canned_text（見
 * services/stt_service.py），沒辦法用來測試「使用者真的說了某句話 →
 * 對應的多 Agent 回覆」這條路徑。這裡用瀏覽器內建的 Web Speech API
 * （SpeechRecognition）在前端就地把語音轉成文字，再直接以 user_text
 * 訊息送給後端——完全繞過後端 STT（不管後端 STT 是 mock 還是真的雙引擎），
 * 純粹是前端「測試用語音輸入」的替代方案，跟後端 STT 設定完全獨立，
 * 也不會、也不應該取代之後真正串接 Breeze ASR / faster-whisper 的行為。
 *
 * 跟 browserTts.js 一樣，把「純邏輯（可測試）」跟「實際碰瀏覽器 API
 * （不可測試，只能在真的瀏覽器上驗證）」分開。
 */

export function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

export function isBrowserSttSupported() {
  return getSpeechRecognitionCtor() !== null
}

/** 純邏輯：辨識結果文字清理（去除頭尾空白），方便單元測試，不用碰真的瀏覽器 API。 */
export function normalizeRecognizedText(text) {
  return (text || '').trim()
}

/**
 * 建立一個瀏覽器語音辨識 session（push-to-talk 風格：外部呼叫 start()/stop()）。
 *
 * onFinalResult(text)：辨識到一段最終結果時呼叫（text 已經過 normalizeRecognizedText）。
 * onError(errorCode)/onEnd()：對應轉發 SpeechRecognition 的 error / end 事件，
 * 讓呼叫端可以在辨識結束時把「錄音中」UI 狀態收掉。
 *
 * 瀏覽器不支援時回傳 null，呼叫端應該先用 isBrowserSttSupported() 檢查。
 */
export function createBrowserSttSession({ lang = 'zh-TW', onFinalResult, onError, onEnd } = {}) {
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) return null

  const recognition = new Ctor()
  recognition.lang = lang
  recognition.continuous = false
  recognition.interimResults = false

  recognition.onresult = (event) => {
    const lastResult = event.results[event.results.length - 1]
    const text = normalizeRecognizedText(lastResult && lastResult[0] && lastResult[0].transcript)
    if (text && onFinalResult) onFinalResult(text)
  }
  recognition.onerror = (event) => {
    if (onError) onError(event.error)
  }
  recognition.onend = () => {
    if (onEnd) onEnd()
  }

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
  }
}
