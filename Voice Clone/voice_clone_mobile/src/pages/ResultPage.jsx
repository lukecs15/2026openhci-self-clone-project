/**
 * ResultPage.jsx — 體驗結束後的紀念畫面
 *
 * 對應 QR code 網址 `<mobile_origin>/result?session=<session_id>`（見桌機端
 * pages/VoiceAgentsPage.jsx 的 ResultQrOverlay，辯論/對話結束、後端回寫
 * 結果後才會顯示這個 QR）。輪詢 GET /api/onboarding-sessions/{id}/result：
 *   - 404：這場對話不存在（session id 錯誤，或是還沒開始過任何一輪 onboarding）
 *   - 409：體驗還在進行中，結果還沒寫回，繼續輪詢
 *   - 200：拿到 { summary_text, waveform_signature, participant_agents }，
 *     直接重用桌機端同一套 WaveformAvatar 呈現融合波形 + 總結句子。
 */

import { useEffect, useRef, useState } from 'react'
import WaveformAvatar from '../components/WaveformAvatar'
import { getOnboardingResult } from '../api/onboardingClient'
import { colors } from '../styles/theme'

const POLL_INTERVAL_MS = 2500

function getSessionIdFromUrl() {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('session') || ''
}

const FALLBACK_SIGNATURE = {
  presetName: '融合',
  frequency: 1.2,
  amplitude: 0.3,
  waveHeight: 0.75,
  waveformShape: 0.3,
  hue: 200,
  colorIntensity: 0.55,
}

export default function ResultPage() {
  const sessionId = useRef(getSessionIdFromUrl()).current
  const [status, setStatus] = useState('loading') // loading | pending | not_found | ready | error
  const [result, setResult] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  // 用 ref（而不是在 setInterval 裡讀 state 更新函式的參數）追蹤「還要不要
  // 繼續輪詢」，避免 React StrictMode 下 updater 函式可能被呼叫兩次導致
  // poll() 意外觸發兩次的疑慮，寫法更直接。
  const shouldKeepPollingRef = useRef(true)

  useEffect(() => {
    if (!sessionId) {
      setStatus('not_found')
      return undefined
    }

    let cancelled = false

    const poll = async () => {
      if (!shouldKeepPollingRef.current) return
      try {
        const response = await getOnboardingResult(sessionId)
        if (cancelled) return
        if (response.status === 'ready') {
          setResult(response.result)
          setStatus('ready')
          shouldKeepPollingRef.current = false
        } else if (response.status === 'not_found') {
          setStatus('not_found')
          shouldKeepPollingRef.current = false
        } else {
          setStatus('pending')
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err.message || '無法連線到後端')
          setStatus('error')
        }
      }
    }

    poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [sessionId])

  if (status === 'ready' && result) {
    return <ReadyView result={result} />
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: colors.bg,
        color: colors.text,
        fontFamily: 'system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      {status === 'loading' && <p style={{ color: colors.textMuted }}>載入中…</p>}
      {status === 'pending' && <p style={{ color: colors.textMuted }}>體驗還在進行中，結果準備好會自動顯示…</p>}
      {status === 'not_found' && (
        <p style={{ color: colors.danger }}>
          找不到這場對話，請確認掃描的 QR code 是否正確（或這場體驗尚未開始）。
        </p>
      )}
      {status === 'error' && <p style={{ color: colors.danger }}>{errorMessage}</p>}
    </div>
  )
}

function ReadyView({ result }) {
  const signature = result.waveform_signature || FALLBACK_SIGNATURE
  const participantNames = (result.participant_agents || []).map((a) => a.display_name).filter(Boolean)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: colors.bg,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <WaveformAvatar signature={signature} isSpeaking currentText={result.summary_text} />
      </div>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          textAlign: 'center',
          gap: '1.5rem',
        }}
      >
        <p
          style={{
            maxWidth: '420px',
            fontSize: '1.2rem',
            lineHeight: 1.8,
            color: '#f8fafc',
            textShadow: '0 2px 12px rgba(0,0,0,0.6)',
            margin: 0,
          }}
        >
          {result.summary_text || '謝謝你今天願意敞開心分享。'}
        </p>

        {participantNames.length > 0 && (
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'rgba(226,232,240,0.75)' }}>
            這次一起參與的自我：{participantNames.join('、')}
          </p>
        )}
      </div>
    </div>
  )
}
