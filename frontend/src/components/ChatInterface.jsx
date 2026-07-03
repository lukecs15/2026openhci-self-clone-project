/**
 * ChatInterface.jsx - 與物品對話的聊天 UI
 *
 * 功能：
 * - 顯示多輪對話歷史（左側：物品/自我；右側：使用者）
 * - 訊息泡泡，物品使用縮圖作為頭像
 * - 輸入框 + Enter 送出
 * - 呼叫後端 /api/chat
 */

import { useState, useRef, useEffect } from 'react'
import { sendChat } from '../api/client'
import useAppStore from '../store/useAppStore'

// 物品頭像佔位符（若無縮圖則使用）
function ObjectAvatar({ thumbnailUrl, size = 36 }) {
  if (thumbnailUrl) {
    return (
      <img
        src={thumbnailUrl}
        alt="物品"
        style={{
          width: size, height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          border: '2px solid #6366f1',
          flexShrink: 0,
        }}
      />
    )
  }
  return (
    <div style={{
      width: size, height: size,
      borderRadius: '50%',
      background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '1rem',
      flexShrink: 0,
    }}>
      ✦
    </div>
  )
}

// 單一訊息泡泡
function MessageBubble({ role, content, thumbnailUrl }) {
  const isUser = role === 'user'
  return (
    <div style={{
      display: 'flex',
      flexDirection: isUser ? 'row-reverse' : 'row',
      gap: '0.625rem',
      alignItems: 'flex-end',
      marginBottom: '1rem',
    }}>
      {!isUser && <ObjectAvatar thumbnailUrl={thumbnailUrl} />}

      <div style={{
        maxWidth: '70%',
        padding: '0.75rem 1rem',
        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: isUser ? '#312e81' : '#1e293b',
        color: isUser ? '#c7d2fe' : '#e2e8f0',
        fontSize: '0.9rem',
        lineHeight: 1.6,
        border: `1px solid ${isUser ? '#4338ca' : '#334155'}`,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {content}
      </div>

      {isUser && (
        <div style={{
          width: 32, height: 32,
          borderRadius: '50%',
          background: '#312e81',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.875rem',
          flexShrink: 0,
          border: '2px solid #4338ca',
        }}>
          我
        </div>
      )}
    </div>
  )
}

// 打字中動畫
function TypingIndicator({ thumbnailUrl }) {
  return (
    <div style={{ display: 'flex', gap: '0.625rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
      <ObjectAvatar thumbnailUrl={thumbnailUrl} />
      <div style={{
        padding: '0.75rem 1rem',
        borderRadius: '16px 16px 16px 4px',
        background: '#1e293b',
        border: '1px solid #334155',
        display: 'flex', gap: '4px', alignItems: 'center',
      }}>
        {[0, 0.2, 0.4].map((delay, i) => (
          <div key={i} style={{
            width: '6px', height: '6px',
            borderRadius: '50%',
            background: '#6366f1',
            animation: `bounce 1s ${delay}s infinite`,
          }} />
        ))}
      </div>
      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-6px); }
        }
      `}</style>
    </div>
  )
}

/**
 * 對話介面主組件。
 *
 * @param {object} props
 * @param {string|null} props.thumbnailUrl - 物品縮圖 URL（作為頭像）
 */
export default function ChatInterface({ thumbnailUrl }) {
  const personality = useAppStore((s) => s.personality)
  const sessionId = useAppStore((s) => s.sessionId)
  const setError = useAppStore((s) => s.setError)

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  // 初始歡迎訊息
  useEffect(() => {
    const objectName = personality?.object_description?.slice(0, 20) || '你的物品'
    setMessages([{
      role: 'model',
      content: `你好，我是你的「${objectName}」。我在這裡很久了，靜靜地見證你的一切。你想聊什麼？`,
    }])
  }, [personality])

  // 自動捲動到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || isTyping) return

    const userMsg = { role: 'user', content: trimmed }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setIsTyping(true)

    try {
      const data = await sendChat({
        message: trimmed,
        session_id: sessionId,
        personality: personality,
      })
      setMessages((prev) => [...prev, { role: 'model', content: data.reply }])
    } catch (err) {
      setError(err.message)
      setMessages((prev) => [...prev, {
        role: 'model',
        content: '（我現在無法回應，也許是信號太弱了...請稍後再試。）',
      }])
    } finally {
      setIsTyping(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '600px',
      background: '#0f172a',
      borderRadius: '12px',
      border: '1px solid #1e293b',
      overflow: 'hidden',
    }}>
      {/* 標題列 */}
      <div style={{
        padding: '1rem 1.25rem',
        background: '#1e293b',
        borderBottom: '1px solid #334155',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
      }}>
        <ObjectAvatar thumbnailUrl={thumbnailUrl} size={32} />
        <div>
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.9rem' }}>
            {personality?.object_description?.slice(0, 30) || '你的物品'}
          </div>
          <div style={{ color: '#64748b', fontSize: '0.75rem' }}>你自我的一部分</div>
        </div>
        <div style={{
          marginLeft: 'auto',
          width: '8px', height: '8px',
          borderRadius: '50%',
          background: '#10b981',
        }} />
      </div>

      {/* 訊息列表 */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1.25rem',
      }}>
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            role={msg.role}
            content={msg.content}
            thumbnailUrl={thumbnailUrl}
          />
        ))}
        {isTyping && <TypingIndicator thumbnailUrl={thumbnailUrl} />}
        <div ref={bottomRef} />
      </div>

      {/* 輸入列 */}
      <div style={{
        padding: '0.875rem 1.25rem',
        background: '#1e293b',
        borderTop: '1px solid #334155',
        display: 'flex',
        gap: '0.625rem',
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="說點什麼... (Enter 送出，Shift+Enter 換行)"
          rows={1}
          disabled={isTyping}
          style={{
            flex: 1,
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '8px',
            color: '#e2e8f0',
            padding: '0.625rem 0.875rem',
            fontSize: '0.9rem',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.5,
            maxHeight: '120px',
            overflowY: 'auto',
          }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isTyping}
          style={{
            padding: '0.625rem 1rem',
            background: !input.trim() || isTyping ? '#334155' : '#6366f1',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            cursor: !input.trim() || isTyping ? 'not-allowed' : 'pointer',
            fontSize: '1.125rem',
            transition: 'background 0.15s',
            flexShrink: 0,
          }}
        >
          ↑
        </button>
      </div>
    </div>
  )
}
