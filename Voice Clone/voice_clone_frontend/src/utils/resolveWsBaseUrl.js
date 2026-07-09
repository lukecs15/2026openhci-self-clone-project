/**
 * resolveWsBaseUrl.js — 校正 WebSocket base URL 的 scheme，避免被瀏覽器當成
 * mixed content 擋掉。
 *
 * 修過的真實問題：VITE_WS_BASE_URL 設成 ws://（非加密），但頁面本身是透過
 * Cloudflare tunnel 用 https:// 開啟（例如 https://xxxx.trycloudflare.com），
 * 瀏覽器會把 `new WebSocket('ws://...')` 視為從安全頁面發出的不安全連線
 * （mixed content），直接擋掉——不會有 console 錯誤、也不會有網路請求紀錄，
 * 症狀就是「按下開始討論／開始對話完全沒反應」，很難第一時間排查出來。
 *
 * 這裡在建立連線前自動把 scheme 校正成跟目前頁面一致（https 頁面一律用
 * wss://），當作最後一道防線：即使 .env 的 VITE_WS_BASE_URL 忘記改、或
 * Cloudflare 每次重啟 tunnel 產生的新網址又被貼錯 scheme，也不會整個卡死、
 * 靜默失敗。
 */
export function resolveWsBaseUrl(rawBaseUrl) {
  if (typeof window === 'undefined' || !rawBaseUrl) return rawBaseUrl

  const pageIsSecure = window.location.protocol === 'https:'
  if (pageIsSecure && rawBaseUrl.startsWith('ws://')) {
    return `wss://${rawBaseUrl.slice('ws://'.length)}`
  }
  return rawBaseUrl
}
