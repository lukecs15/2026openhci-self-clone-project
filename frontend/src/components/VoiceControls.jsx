/**
 * VoiceControls.jsx — 語音輸入控制列
 *
 * 懸浮在場景底部，包含：
 * - 按住說話按鈕（push-to-talk 模式）或一次切換（toggle 模式）
 * - 文字輸入欄（收合式，點擊展開）
 * - 音量指示器（Web Audio API 動態波形）
 * - 結束按鈕（exchange_count >= 10 後出現）
 *
 * Props：
 *   @param {boolean}  isConnected    - WebSocket 是否已連接
 *   @param {boolean}  isRecording    - 是否正在錄音
 *   @param {string}   recordingMode  - 'push' | 'toggle'
 *   @param {boolean}  canEnd         - 是否顯示結束按鈕
 *   @param {boolean}  disabled       - 物件說話中時禁用輸入
 *   @param {Function} onStartRecord  - 開始錄音
 *   @param {Function} onStopRecord   - 停止錄音
 *   @param {Function} onSendText     - 送出文字訊息
 *   @param {Function} onEndSession   - 結束對話
 *   @param {Function} onToggleMode   - 切換 push/toggle 模式
 *   @param {string}   userTranscript - STT 結果（即時顯示）
 *
 * TODO: 加入音量波形（Web Audio API AnalyserNode）
 * TODO: 加入 VAD 自動偵測靜音停止錄音
 */

import { useRef, useState, useCallback } from 'react'

// 麥克風 icon SVG
const MicIcon = ({ active }) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
    <rect x="9" y="2" width="6" height="12" rx="3"
      fill={active ? '#a78bfa' : 'currentColor'} />
    <path d="M5 10a7 7 0 0014 0" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" fill="none" />
    <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" />
    <line x1="8" y1="21" x2="16" y2="21" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" />
  </svg>
)

// 送出 icon SVG
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
  </svg>
)

export default function VoiceControls({
  isConnected = false,
  isRecording = false,
  recordingMode = 'push',
  canEnd = false,
  disabled = false,
  onStartRecord,
  onStopRecord,
  onSendText,
  onEndSession,
  onToggleMode,
  userTranscript = '',
}) {
  const [textExpanded, setTextExpanded] = useState(false)
  const [inputText, setInputText] = useState('')
  const inputRef = useRef(null)

  // ── Push-to-talk 事件 ─────────────────────────────────────────────────────
  const handleMicPointerDown = useCallback((e) => {
    e.preventDefault()
    if (!isConnected || disabled) return
    if (recordingMode === 'push') {
      onStartRecord?.()
    } else {
      // toggle 模式
      if (isRecording) onStopRecord?.()
      else onStartRecord?.()
    }
  }, [isConnected, disabled, recordingMode, isRecording, onStartRecord, onStopRecord])

  const handleMicPointerUp = useCallback(() => {
    if (recordingMode === 'push' && isRecording) {
      onStopRecord?.()
    }
  }, [recordingMode, isRecording, onStopRecord])

  // ── 文字輸入 ──────────────────────────────────────────────────────────────
  const handleTextSubmit = useCallback((e) => {
    e.preventDefault()
    const text = inputText.trim()
    if (!text || !isConnected || disabled) return
    onSendText?.(text)
    setInputText('')
  }, [inputText, isConnected, disabled, onSendText])

  const toggleTextInput = useCallback(() => {
    setTextExpanded(v => {
      if (!v) setTimeout(() => inputRef.current?.focus(), 50)
      return !v
    })
  }, [])

  // ── 按鈕文字 ─────────────────────────────────────────────────────────────
  const micLabel = !isConnected
    ? '未連接'
    : disabled
    ? '物件說話中…'
    : isRecording
    ? (recordingMode === 'push' ? '放開傳送' : '點擊停止')
    : (recordingMode === 'push' ? '按住說話' : '點擊說話')

  return (
    <div style={{
      position: 'fixed',
      bottom: '2rem',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '0.75rem',
      zIndex: 100,
      pointerEvents: 'all',
    }}>
      {/* STT 即時顯示 */}
      {userTranscript && (
        <div style={{
          background: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(99, 102, 241, 0.3)',
          borderRadius: '999px',
          padding: '0.4rem 1.2rem',
          color: '#c4b5fd',
          fontSize: '0.875rem',
          maxWidth: '400px',
          textAlign: 'center',
          fontStyle: 'italic',
        }}>
          {userTranscript}
        </div>
      )}

      {/* 收合式文字輸入 */}
      {textExpanded && (
        <form onSubmit={handleTextSubmit} style={{
          display: 'flex',
          gap: '0.5rem',
          background: 'rgba(15, 23, 42, 0.85)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          borderRadius: '999px',
          padding: '0.4rem 0.4rem 0.4rem 1rem',
          width: '320px',
        }}>
          <input
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="輸入文字…"
            disabled={!isConnected || disabled}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#e2e8f0',
              fontSize: '0.9rem',
            }}
          />
          <button
            type="submit"
            disabled={!inputText.trim() || !isConnected || disabled}
            style={{
              background: '#6366f1',
              border: 'none',
              borderRadius: '50%',
              width: '36px',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              cursor: 'pointer',
              opacity: (!inputText.trim() || !isConnected || disabled) ? 0.4 : 1,
            }}
          >
            <SendIcon />
          </button>
        </form>
      )}

      {/* 主要控制列 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        background: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(99, 102, 241, 0.3)',
        borderRadius: '999px',
        padding: '0.75rem 1.5rem',
      }}>
        {/* 模式切換（push / toggle） */}
        <button
          onClick={onToggleMode}
          title={recordingMode === 'push' ? '切換為：點按模式' : '切換為：按住模式'}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#64748b',
            cursor: 'pointer',
            fontSize: '0.7rem',
            padding: '0 0.5rem',
          }}
        >
          {recordingMode === 'push' ? '按住' : '點按'}
        </button>

        {/* 麥克風按鈕（主要） */}
        <button
          onPointerDown={handleMicPointerDown}
          onPointerUp={handleMicPointerUp}
          onPointerLeave={handleMicPointerUp}
          disabled={!isConnected || disabled}
          style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            border: isRecording
              ? '2px solid #a78bfa'
              : '2px solid rgba(99, 102, 241, 0.5)',
            background: isRecording
              ? 'rgba(167, 139, 250, 0.2)'
              : 'rgba(99, 102, 241, 0.15)',
            color: '#c4b5fd',
            cursor: (!isConnected || disabled) ? 'not-allowed' : 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
            transition: 'all 0.2s',
            boxShadow: isRecording
              ? '0 0 20px rgba(167, 139, 250, 0.4)'
              : 'none',
            opacity: (!isConnected || disabled) ? 0.5 : 1,
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        >
          <MicIcon active={isRecording} />
          <span style={{ fontSize: '9px', color: '#94a3b8', letterSpacing: '0.03em' }}>
            {micLabel}
          </span>
        </button>

        {/* 文字輸入切換 */}
        <button
          onClick={toggleTextInput}
          title="文字輸入"
          style={{
            background: textExpanded ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
            border: '1px solid rgba(99, 102, 241, 0.3)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✏
        </button>
      </div>

      {/* 結束按鈕（fade in 後出現） */}
      {canEnd && (
        <button
          onClick={onEndSession}
          style={{
            background: 'rgba(15, 23, 42, 0.7)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(203, 213, 225, 0.2)',
            borderRadius: '999px',
            padding: '0.5rem 2rem',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '0.85rem',
            animation: 'fadeInUp 0.5s ease',
          }}
        >
          結束對話
        </button>
      )}

      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
