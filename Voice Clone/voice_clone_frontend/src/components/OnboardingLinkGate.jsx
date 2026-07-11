/**
 * OnboardingLinkGate.jsx — 開場「等待手機掃碼連結」畫面
 *
 * 對應 mobile onboarding 流程（見 voice_clone_backend/routers/onboarding.py）：
 * 使用者先在手機獨立填 Big Five 問卷 + 錄一段聲音樣本，填完後掃這裡顯示的
 * QR code，手機把問卷 + 聲音樣本 POST 到後端 /api/onboarding-sessions/{id}/link，
 * 後端建立聲音克隆 profile + 依五個向度生成 5 位「自我」agent。這個元件負責：
 *
 *   1. 把 QR code（內容是手機連結頁網址，帶這個 session_id）畫出來，同時
 *      顯示原始網址文字（方便還沒有手機前端、或不方便用手機掃碼時，直接
 *      複製網址用 curl/Postman 模擬測試）。
 *   2. 輪詢 GET /api/onboarding-sessions/{session_id}，還沒連結時後端回
 *      404，這裡當成「還在等待」，不當錯誤處理；一旦查到 status 是
 *      linked/completed，就把生成好的 5 位 agent 回傳給呼叫端。
 *
 * 刻意設計成一個獨立元件（不直接寫在 VoiceAgentsPage.jsx 裡）：這個畫面
 * 之後的視覺設計還會再調整，先讓功能可以獨立測試、之後改介面不會動到
 * 呼叫端的串接邏輯。
 *
 * 「先測試功能」的兩個逃生艙口：
 *   - 略過連結：不透過手機問卷，直接用既有的 3 位 demo agent（DEFAULT_DEMO_AGENTS）
 *     測試其餘對話/辯論功能，不需要真的準備手機前端。
 *   - 重新產生 QR：換一組新的 session_id（等於重新整理這個「連結槽」），
 *     不需要重新整理整個頁面就能重測連結流程。
 */

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8200/api'
const POLL_INTERVAL_MS = 2000

export default function OnboardingLinkGate({ sessionId, linkUrl, onLinked, onSkip, onRegenerate }) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [pollError, setPollError] = useState('')

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(linkUrl, { width: 260, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('')
      })
    return () => {
      cancelled = true
    }
  }, [linkUrl])

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/onboarding-sessions/${sessionId}`)
        if (res.status === 404) {
          // 還沒連結，正常的等待狀態，不算錯誤。
          if (!cancelled) setPollError('')
          return
        }
        if (!res.ok) {
          if (!cancelled) setPollError(`查詢連結狀態失敗（${res.status}）`)
          return
        }
        const session = await res.json()
        if (!cancelled && (session.status === 'linked' || session.status === 'completed')) {
          onLinked(session.agents || [])
        }
      } catch {
        if (!cancelled) setPollError('無法連線到後端，請確認後端服務是否啟動')
      }
    }

    poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [sessionId, onLinked])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '1rem',
        padding: '2rem 1rem',
        textAlign: 'center',
      }}
    >
      <h2 style={{ margin: 0, fontSize: '1.1rem' }}>請用手機掃描 QR code 連結問卷</h2>
      <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8', maxWidth: '420px' }}>
        在手機上填寫 Big Five 問卷並錄一段聲音樣本後，掃描下方 QR code
        上傳，系統會依五個人格向度生成 5 位「自我」agent，都會用你剛剛
        克隆的聲音回覆。
      </p>

      {qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt="連結問卷用 QR code"
          style={{ width: 220, height: 220, borderRadius: '0.75rem', background: '#fff', padding: '0.5rem' }}
        />
      ) : (
        <div
          style={{
            width: 220,
            height: 220,
            borderRadius: '0.75rem',
            background: '#0f172a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#475569',
            fontSize: '0.8rem',
          }}
        >
          QR code 產生中…
        </div>
      )}

      <p style={{ margin: 0, fontSize: '0.7rem', color: '#475569', wordBreak: 'break-all', maxWidth: '420px' }}>
        {linkUrl}
      </p>

      <p style={{ margin: 0, fontSize: '0.8rem', color: '#6366f1' }}>等待手機掃碼連結中…</p>

      {pollError && <p style={{ margin: 0, fontSize: '0.75rem', color: '#ef4444' }}>{pollError}</p>}

      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
        <button onClick={onRegenerate} style={secondaryButtonStyle}>
          重新產生 QR
        </button>
        <button onClick={onSkip} style={secondaryButtonStyle}>
          略過連結，使用預設 demo agent
        </button>
      </div>
    </div>
  )
}

const secondaryButtonStyle = {
  padding: '0.5rem 1rem',
  borderRadius: '0.5rem',
  border: '1px solid #334155',
  background: '#0f172a',
  color: '#94a3b8',
  fontSize: '0.75rem',
  cursor: 'pointer',
}
