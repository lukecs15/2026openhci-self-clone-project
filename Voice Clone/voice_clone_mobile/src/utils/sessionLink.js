/**
 * sessionLink.js — 把「掃描 QR code 得到的文字」解析成 session id
 *
 * 桌機端 QR code 內容是完整網址（見 voice_clone_frontend/components/
 * OnboardingLinkGate.jsx 的 `linkUrl`，格式 `<mobile_origin>/link?session=<id>`），
 * 但這裡刻意也接受「QR code 直接編碼純 session id 字串」的情況（不是合法
 * 網址時，原樣把掃到的文字當 session id 用）——手動測試時常常會就地生成一個
 * 只包含 session id 的 QR，不想每次都要組一個完整網址。
 *
 * 純函式，跟相機/DOM 完全無關，方便單元測試（見 components/QrScanner.jsx
 * 呼叫端）。
 *
 * @param {string} scannedText
 * @returns {string} 解析出的 session id（找不到就回傳去除頭尾空白後的原始文字）
 */
export function extractSessionIdFromScannedText(scannedText) {
  if (!scannedText) return ''
  const trimmed = scannedText.trim()

  try {
    const url = new URL(trimmed)
    const fromQuery = url.searchParams.get('session')
    if (fromQuery) return fromQuery
  } catch {
    // 不是合法的絕對網址（例如 QR 直接編碼裸的 session id），落到下面直接回傳原文字
  }

  return trimmed
}
