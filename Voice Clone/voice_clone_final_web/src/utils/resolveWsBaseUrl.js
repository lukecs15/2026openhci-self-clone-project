/**
 * resolveWsBaseUrl.js — 校正 WebSocket base URL 的 scheme
 *
 * 與 voice_clone_frontend/src/utils/resolveWsBaseUrl.js 同一份實作：頁面走
 * https（例如 cloudflared tunnel）時把 ws:// 自動升級成 wss://，避免 mixed
 * content 被瀏覽器靜默擋掉（沒有 console 錯誤、沒有網路請求，非常難查）。
 */
export function resolveWsBaseUrl(rawBaseUrl) {
  if (typeof window === 'undefined' || !rawBaseUrl) return rawBaseUrl

  const pageIsSecure = window.location.protocol === 'https:'
  if (pageIsSecure && rawBaseUrl.startsWith('ws://')) {
    return `wss://${rawBaseUrl.slice('ws://'.length)}`
  }
  return rawBaseUrl
}
