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
  const verdict = result.verdict || null
  // final web 三情境體驗的聚合報告（見後端 schemas.py 的 OnboardingResult
  // .scenarios 說明）：有這個欄位就改走三情境報告視圖；沒有（Unity/舊
  // 網頁版單場流程）照舊顯示單份判決書，向後相容。
  const scenarios = Array.isArray(result.scenarios) ? result.scenarios : []

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: colors.bg,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}
    >
      <div style={{ position: 'fixed', inset: 0 }}>
        <WaveformAvatar signature={signature} isSpeaking currentText={result.summary_text} />
      </div>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: verdict ? 'flex-start' : 'center',
          minHeight: '100vh',
          padding: '2rem 1.25rem 3rem',
          textAlign: 'center',
          gap: '1.25rem',
        }}
      >
        {scenarios.length > 0 ? (
          <ScenariosDocument scenarios={scenarios} />
        ) : (
          verdict && <VerdictDocument verdict={verdict} topicTitle={result.topic_title} />
        )}

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
          {result.summary_text || verdict?.closing_line || '謝謝你今天願意敞開心分享。'}
        </p>

        {participantNames.length > 0 && (
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'rgba(226,232,240,0.75)' }}>
            這次出庭的自我：{participantNames.join('、')}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * ScenariosDocument — final web 三情境體驗的逐情境報告
 *
 * 對照後端 OnboardingResult.scenarios 的結構（每情境：選擇、討論摘要、
 * 介入思考變化）。視覺沿用 VerdictDocument 的紙本文書風格。
 */
function ScenariosDocument({ scenarios }) {
  const sectionTitleStyle = {
    margin: '0 0 0.25rem',
    fontSize: '0.72rem',
    letterSpacing: '0.15em',
    color: 'rgba(226,215,180,0.85)',
  }
  const sectionBodyStyle = {
    margin: 0,
    fontSize: '0.9rem',
    lineHeight: 1.75,
    color: 'rgba(248,250,252,0.92)',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', maxWidth: '440px' }}>
      <p style={{ margin: 0, textAlign: 'center', fontSize: '1.05rem', letterSpacing: '0.25em', color: '#e8dcb4' }}>
        內在對話 體驗報告
      </p>
      {scenarios.map((s, i) => (
        <div
          key={s.scenario_id || i}
          style={{
            textAlign: 'left',
            background: 'rgba(10,12,20,0.78)',
            border: '1px solid rgba(226,215,180,0.35)',
            borderRadius: '0.9rem',
            padding: '1.2rem 1.25rem',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: '0.72rem', letterSpacing: '0.3em', color: 'rgba(226,232,240,0.6)' }}>
              情境 {i + 1}
            </p>
            <p style={{ margin: '0.25rem 0 0', fontSize: '1rem', color: '#f1f5f9' }}>{s.title}</p>
          </div>
          {s.choice_label && (
            <div>
              <p style={sectionTitleStyle}>你的選擇</p>
              <p style={{ ...sectionBodyStyle, color: '#c7e3ff' }}>{s.choice_label}</p>
            </div>
          )}
          {s.summary && (
            <div>
              <p style={sectionTitleStyle}>討論摘要</p>
              <p style={sectionBodyStyle}>{s.summary}</p>
            </div>
          )}
          {s.intervention_reflection && (
            <div>
              <p style={sectionTitleStyle}>你介入時的思考</p>
              <p style={sectionBodyStyle}>{s.intervention_reflection}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * VerdictDocument — 「內在法庭」判決書（對照後端 agents/debate.py 的
 * generate_verdict() 欄位）。舊資料沒有 verdict 欄位時整段不顯示，
 * ReadyView 退回原本「一句總結語 + 融合波形」的呈現。
 */
function VerdictDocument({ verdict, topicTitle }) {
  const sectionTitleStyle = {
    margin: '0 0 0.25rem',
    fontSize: '0.72rem',
    letterSpacing: '0.15em',
    color: 'rgba(226,215,180,0.85)',
  }
  const sectionBodyStyle = {
    margin: 0,
    fontSize: '0.9rem',
    lineHeight: 1.75,
    color: 'rgba(248,250,252,0.92)',
  }

  return (
    <div
      style={{
        width: '100%',
        maxWidth: '440px',
        textAlign: 'left',
        background: 'rgba(10,12,20,0.78)',
        border: '1px solid rgba(226,215,180,0.35)',
        borderRadius: '0.9rem',
        padding: '1.4rem 1.25rem',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: '1.05rem', letterSpacing: '0.25em', color: '#e8dcb4' }}>
          心智最高法院 判決書
        </p>
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'rgba(226,232,240,0.7)' }}>
          {verdict.case_title || topicTitle || ''}
        </p>
      </div>

      {verdict.initial_bias && (
        <div>
          <p style={sectionTitleStyle}>最初的成見</p>
          <p style={sectionBodyStyle}>{verdict.initial_bias}</p>
        </div>
      )}

      {(verdict.viewpoint_a || verdict.viewpoint_b) && (
        <div>
          <p style={sectionTitleStyle}>兩造主張</p>
          {verdict.viewpoint_a && <p style={sectionBodyStyle}>・{verdict.viewpoint_a}</p>}
          {verdict.viewpoint_b && <p style={sectionBodyStyle}>・{verdict.viewpoint_b}</p>}
        </div>
      )}

      {Array.isArray(verdict.judge_interventions) && verdict.judge_interventions.length > 0 && (
        <div>
          <p style={sectionTitleStyle}>法官（你）的介入意見</p>
          {verdict.judge_interventions.map((line, i) => (
            <p key={i} style={sectionBodyStyle}>・{line}</p>
          ))}
        </div>
      )}

      {verdict.final_verdict && (
        <div>
          <p style={sectionTitleStyle}>本庭判決</p>
          <p style={sectionBodyStyle}>{verdict.final_verdict}</p>
        </div>
      )}

      {verdict.revised_belief && (
        <div>
          <p style={sectionTitleStyle}>修正後的信念</p>
          <p style={{ ...sectionBodyStyle, color: '#c7e3ff' }}>{verdict.revised_belief}</p>
        </div>
      )}
    </div>
  )
}
