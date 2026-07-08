/**
 * DevToggleLabel.jsx — 開發用小開關（checkbox + 說明文字）
 *
 * 用於「用瀏覽器語音朗讀／辨識」這類跟後端 STT/TTS 是否 mock 完全獨立的
 * 前端測試輔助開關。從 VoiceAgentsPage.jsx 抽出成獨立元件，讓辯論模式
 * （DebateStage.jsx）也能重用同一套樣式，兩種模式的開關看起來一致。
 */

export default function DevToggleLabel({ checked, disabled, onChange, title, children }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        fontSize: '0.8rem',
        color: '#94a3b8',
        margin: '0.35rem 0',
        opacity: disabled ? 0.5 : 1,
      }}
      title={title}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      {children}
    </label>
  )
}
