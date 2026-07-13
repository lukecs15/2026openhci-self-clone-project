/**
 * courtFeedback.js — 法庭主題的感官回饋：震動（buzz）+ 五聲音階提示音（ping）
 *
 * 逐字從設計稿 inner-court-survey-fix8.html 搬過來。ping() 用 Web Audio
 * 振盪器即時合成音效（不需要載入任何音檔），每個 OCEAN 向度對應一個音高，
 * 答題/開庭時彈一聲，是設計稿刻意設計的「五聲音階」聽覺語言，跟畫面上的
 * 五色語言互相呼應。
 *
 * AudioContext 是全域單例（瀏覽器對 AudioContext 數量有限制，而且需要使用者
 * 手勢後才能真正發聲，第一次呼叫 ping() 時建立即可，不需要等某個「初始化」
 * 步驟）。
 */

const NOTES = { C: 523.25, N: 587.33, A: 659.26, O: 783.99, E: 880.0 }

let audioContext = null

function getAudioContext() {
  if (!audioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextCtor) return null
    audioContext = new AudioContextCtor()
  }
  return audioContext
}

/** 震動回饋，裝置/瀏覽器不支援 navigator.vibrate 時安靜地什麼都不做。 */
export function buzz(ms = 8) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(ms)
    } catch {
      // 部分瀏覽器在非使用者手勢情境下呼叫 vibrate 會拋例外，忽略即可，
      // 震動只是錦上添花，不影響任何功能正確性。
    }
  }
}

/**
 * 播放一個 OCEAN 向度對應的提示音（五聲音階，短促的正弦/三角波）。
 * @param {'C'|'N'|'A'|'O'|'E'} key
 */
export function ping(key) {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') ctx.resume()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = key === 'A' ? 'triangle' : 'sine'
    o.frequency.value = NOTES[key] || NOTES.C
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6)
    o.connect(g)
    g.connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.65)
  } catch {
    // 音效播放失敗（例如瀏覽器政策擋住、裝置不支援）不影響任何實際功能，
    // 安靜地忽略即可，不應該讓整個互動因為聲音播不出來而中斷。
  }
}

export { getAudioContext }
