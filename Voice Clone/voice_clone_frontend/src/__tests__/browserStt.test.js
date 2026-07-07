/**
 * browserStt.test.js — 驗證瀏覽器 STT 輔助工具的純邏輯部分
 *
 * jsdom 環境沒有真正的 SpeechRecognition/webkitSpeechRecognition，所以
 * isBrowserSttSupported()/createBrowserSttSession() 在測試環境下應該回傳
 * false/null（優雅地表示「不支援」，而不是丟例外），實際辨識行為只能在
 * 真的瀏覽器上驗證。
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeRecognizedText,
  isBrowserSttSupported,
  createBrowserSttSession,
  getSpeechRecognitionCtor,
} from '../utils/browserStt'

describe('normalizeRecognizedText', () => {
  it('去除頭尾空白', () => {
    expect(normalizeRecognizedText('  你好嗎  ')).toBe('你好嗎')
  })

  it('undefined/null/空字串都回傳空字串', () => {
    expect(normalizeRecognizedText(undefined)).toBe('')
    expect(normalizeRecognizedText(null)).toBe('')
    expect(normalizeRecognizedText('')).toBe('')
  })
})

describe('isBrowserSttSupported / getSpeechRecognitionCtor', () => {
  it('在測試環境（jsdom 沒有 SpeechRecognition）下回傳 false / null', () => {
    expect(isBrowserSttSupported()).toBe(false)
    expect(getSpeechRecognitionCtor()).toBeNull()
  })
})

describe('createBrowserSttSession', () => {
  it('瀏覽器不支援時回傳 null，而不是丟例外', () => {
    expect(() => createBrowserSttSession({ onFinalResult: () => {} })).not.toThrow()
    expect(createBrowserSttSession({ onFinalResult: () => {} })).toBeNull()
  })
})
