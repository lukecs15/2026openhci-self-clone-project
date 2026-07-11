/**
 * LikertQuestion.jsx — 單題 Likert 量表卡片（大按鈕、適合手機點選）
 *
 * 一次只顯示一題（呼叫端 pages/OnboardingFlow.jsx 控制目前是第幾題），
 * 點選選項後直接呼叫 onAnswer，呼叫端自行決定要不要自動跳下一題。
 */
import { LIKERT_OPTIONS } from '../data/bigFiveQuestions'
import { colors } from '../styles/theme'

export default function LikertQuestion({ text, value, onAnswer }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p style={{ margin: 0, fontSize: '1.15rem', lineHeight: 1.6, minHeight: '3.2em' }}>{text}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {LIKERT_OPTIONS.map((opt) => {
          const selected = value === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => onAnswer(opt.value)}
              style={{
                padding: '0.9rem 1rem',
                borderRadius: '0.75rem',
                border: selected ? `2px solid ${colors.accent}` : `1px solid ${colors.border}`,
                background: selected ? 'rgba(99,102,241,0.15)' : colors.card,
                color: selected ? colors.accentSoft : colors.text,
                fontSize: '1rem',
                fontWeight: selected ? 700 : 400,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
