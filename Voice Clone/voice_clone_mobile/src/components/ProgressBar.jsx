/**
 * ProgressBar.jsx — 問卷進度條
 */
import { colors } from '../styles/theme'

export default function ProgressBar({ current, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
  return (
    <div>
      <div
        style={{
          height: '6px',
          borderRadius: '999px',
          background: colors.card,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: colors.accent,
            transition: 'width 0.25s ease',
          }}
        />
      </div>
      <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: colors.textFaint, textAlign: 'right' }}>
        {current} / {total}
      </p>
    </div>
  )
}
