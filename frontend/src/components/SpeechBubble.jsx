/**
 * SpeechBubble.jsx — 對話泡泡元件（掛在 3D 物件上方）
 *
 * 使用 @react-three/drei 的 Html 元件，將 DOM 元素固定在 3D 空間中。
 * 逐字顯示效果（Typewriter），讓對話更有臨場感。
 *
 * Props：
 *   @param {string} text        - 要顯示的文字（完整文字，逐字動畫）
 *   @param {string} objectName  - 物件名稱（顯示在泡泡頂端）
 *   @param {number} yOffset     - 距物件中心的 Y 軸偏移
 *
 * TODO: 加入 TTS 播放進度同步（逐字與音訊對齊）
 * TODO: 超過 3 行自動收折，點擊展開
 * TODO: 支援 markdown 格式（粗體、換行）
 */

import { useEffect, useRef, useState } from 'react'
import { Html } from '@react-three/drei'

// 逐字顯示速度（ms/字）
const TYPEWRITER_SPEED = 60

function TypewriterText({ text }) {
  const [displayed, setDisplayed] = useState('')
  const indexRef = useRef(0)
  const timerRef = useRef(null)

  useEffect(() => {
    // 重置
    setDisplayed('')
    indexRef.current = 0
    clearInterval(timerRef.current)

    if (!text) return

    timerRef.current = setInterval(() => {
      indexRef.current += 1
      setDisplayed(text.slice(0, indexRef.current))
      if (indexRef.current >= text.length) {
        clearInterval(timerRef.current)
      }
    }, TYPEWRITER_SPEED)

    return () => clearInterval(timerRef.current)
  }, [text])

  return <span>{displayed}</span>
}

export default function SpeechBubble({ text, objectName = '', yOffset = 1.0 }) {
  return (
    <Html
      position={[0, yOffset, 0]}
      center
      distanceFactor={5}
      style={{ pointerEvents: 'none' }}
    >
      <div style={{
        width: '280px',
        background: 'rgba(15, 23, 42, 0.92)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(99, 102, 241, 0.5)',
        borderRadius: '14px',
        padding: '12px 16px',
        boxShadow: '0 6px 32px rgba(99, 102, 241, 0.25)',
        fontFamily: 'system-ui, "Noto Sans TC", sans-serif',
        position: 'relative',
      }}>
        {/* 物件名稱標籤 */}
        {objectName && (
          <div style={{
            fontSize: '10px',
            color: '#a78bfa',
            marginBottom: '6px',
            letterSpacing: '0.08em',
            fontWeight: 700,
            textTransform: 'uppercase',
          }}>
            {objectName}
          </div>
        )}

        {/* 主文字（逐字顯示，完整不截斷） */}
        <div style={{
          fontSize: '13px',
          color: '#e2e8f0',
          lineHeight: 1.7,
          maxHeight: '220px',
          overflowY: 'auto',
          wordBreak: 'break-all',
          whiteSpace: 'pre-wrap',
          /* 自訂捲軸 */
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(99,102,241,0.4) transparent',
        }}>
          <TypewriterText text={text} />
        </div>

        {/* 泡泡尾巴 */}
        <div style={{
          position: 'absolute',
          bottom: '-9px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '9px solid transparent',
          borderRight: '9px solid transparent',
          borderTop: '9px solid rgba(15, 23, 42, 0.92)',
        }} />
      </div>
    </Html>
  )
}
