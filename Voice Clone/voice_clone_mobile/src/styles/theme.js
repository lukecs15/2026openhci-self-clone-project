/**
 * theme.js — 共用樣式常數
 *
 * 跟桌機端 voice_clone_frontend 用同一組深色配色（#020617 背景／#6366f1
 * 主色／#0f172a 卡片背景），維持兩邊視覺語彙一致；這裡額外把常用樣式抽成
 * 共用物件，因為手機端頁面數量比桌機端多（問卷/錄音/上傳/結果四個畫面），
 * 直接複製貼上 inline style 容易漏改。
 */

export const colors = {
  bg: '#020617',
  card: '#0f172a',
  border: '#334155',
  accent: '#6366f1',
  accentSoft: '#a5b4fc',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#64748b',
  danger: '#ef4444',
}

export const pageStyle = {
  minHeight: '100vh',
  background: colors.bg,
  color: colors.text,
  fontFamily: 'system-ui, sans-serif',
  display: 'flex',
  flexDirection: 'column',
}

export const containerStyle = {
  flex: 1,
  maxWidth: '480px',
  width: '100%',
  margin: '0 auto',
  padding: '1.5rem 1.25rem 3rem',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
}

export const primaryButtonStyle = (enabled = true) => ({
  padding: '0.85rem 1.5rem',
  borderRadius: '0.75rem',
  border: 'none',
  background: enabled ? colors.accent : colors.border,
  color: '#fff',
  fontWeight: 700,
  fontSize: '1rem',
  cursor: enabled ? 'pointer' : 'not-allowed',
  width: '100%',
})

export const secondaryButtonStyle = {
  padding: '0.75rem 1.25rem',
  borderRadius: '0.75rem',
  border: `1px solid ${colors.border}`,
  background: 'transparent',
  color: colors.textMuted,
  fontSize: '0.9rem',
  cursor: 'pointer',
  width: '100%',
}

export const cardStyle = {
  background: colors.card,
  borderRadius: '1rem',
  padding: '1.25rem',
}
