/**
 * MicControl.jsx — 麥克風按住說話按鈕 + 文字輸入備援
 */

import { useState } from 'react'

export default function MicControl({ isRecording, onStartRecording, onStopRecording, onSendText }) {
  const [text, setText] = useState('')

  return (
    <div style={{ display: 'flex', gap: '0.75rem', padding: '1rem', alignItems: 'center' }}>
      <button
        onMouseDown={onStartRecording}
        onMouseUp={onStopRecording}
        onTouchStart={onStartRecording}
        onTouchEnd={onStopRecording}
        style={{
          padding: '0.75rem 1.5rem',
          borderRadius: '9999px',
          border: 'none',
          background: isRecording ? '#ef4444' : '#6366f1',
          color: '#fff',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        {isRecording ? '放開結束錄音' : '按住說話'}
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="或直接輸入文字（文字備援）"
        style={{
          flex: 1,
          padding: '0.6rem 1rem',
          borderRadius: '0.5rem',
          border: '1px solid #334155',
          background: '#020617',
          color: '#e2e8f0',
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            onSendText(text.trim())
            setText('')
          }
        }}
      />
    </div>
  )
}
