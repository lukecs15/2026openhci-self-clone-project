/**
 * sessionLink.test.js — 驗證掃描 QR code 文字 → session id 的解析邏輯
 */

import { describe, it, expect } from 'vitest'
import { extractSessionIdFromScannedText } from '../utils/sessionLink'

describe('extractSessionIdFromScannedText', () => {
  it('掃到完整網址時，抓出 session query 參數', () => {
    const text = 'http://localhost:5175/link?session=abc-123-def'
    expect(extractSessionIdFromScannedText(text)).toBe('abc-123-def')
  })

  it('網址帶其他 query 參數時，仍然只抓 session', () => {
    const text = 'http://192.168.1.5:5175/link?foo=bar&session=xyz&baz=1'
    expect(extractSessionIdFromScannedText(text)).toBe('xyz')
  })

  it('掃到的是純 session id（不是合法網址）時，原樣回傳（去頭尾空白）', () => {
    expect(extractSessionIdFromScannedText('  raw-session-id-789  ')).toBe('raw-session-id-789')
  })

  it('是合法網址但沒有 session 參數時，退回用整段文字當 session id', () => {
    const text = 'http://localhost:5175/link'
    expect(extractSessionIdFromScannedText(text)).toBe(text)
  })

  it('空字串或 undefined 回傳空字串，不拋例外', () => {
    expect(extractSessionIdFromScannedText('')).toBe('')
    expect(extractSessionIdFromScannedText(undefined)).toBe('')
  })
})
