/**
 * ConnectGate.jsx — 體驗入口：QR 連結 + 等待手機端上傳
 *
 * 對應整體流程第 2 步：畫面顯示 QR（內容 = 手機連結頁網址 + session_id），
 * 體驗者用手機（voice_clone_mobile）掃碼後填 Big Five 問卷 + 錄聲音樣本
 * （最後一題同時是觀念問題的口述回答），上傳完成後後端 status=linked，
 * 這裡輪詢偵測到就顯示「五個自我已甦醒」的過場與開始按鈕。
 *
 * 注意：voice_reference_text（觀念問題的口述逐字稿）刻意「不」在甦醒
 * 畫面顯示——那是餵給立場 persona 的素材（utils/stancePersona.js），
 * 不是給體驗者看的內容（實測回饋：顯示出來反而干擾儀式感）。
 */

import { useEffect, useRef, useState } from 'react'
import LineOrbs from './LineOrbs'
import BgWash from './BgWash'
import { getOnboardingSession, mobileLinkUrl, qrImageUrl } from '../api/onboardingClient'

const POLL_INTERVAL_MS = 2500

const FIVE_SELVES = [
  { id: 'E', styleKey: 'E', hue: 95, label: '外向性' },
  { id: 'A', styleKey: 'A', hue: 34, label: '親和性' },
  { id: 'C', styleKey: 'C', hue: 255, label: '盡責性' },
  { id: 'N', styleKey: 'N', hue: 350, label: '負向情緒' },
  { id: 'O', styleKey: 'O', hue: 200, label: '開放性' },
]

export default function ConnectGate({ sessionId, onLinked }) {
  const [linkedSession, setLinkedSession] = useState(null)
  const [pollError, setPollError] = useState('')
  const idleSpeakRef = useRef({ activeId: null, level: 0 })

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const session = await getOnboardingSession(sessionId)
        if (cancelled) return
        setPollError('')
        if (session) setLinkedSession(session)
      } catch (err) {
        if (!cancelled) setPollError(`無法連到後端：${err.message}`)
      }
    }
    poll()
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  const linkUrl = mobileLinkUrl(sessionId)

  if (!linkedSession) {
    return (
      <div className="gate">
        <BgWash />
        <h1 className="gateTitle">Whose Inner Voice?</h1>
        <p className="gateSub">用你自己的聲音，聽見內心兩個立場的對話</p>
        <div className="qrBox">
          <img src={qrImageUrl(linkUrl)} alt="掃碼開始：上傳問卷與聲音樣本" width={280} height={280} />
        </div>
        <p className="gateHint">用手機掃描 QR code，完成問卷與聲音採集</p>
        {pollError && <div className="errorNote">{pollError}</div>}
      </div>
    )
  }

  return (
    <div className="gate">
      <BgWash />
      <h1 className="gateTitle">你的五個自我，已經甦醒</h1>
      {/* 深色圓角窗：頁面維持白底，光球區塊用深底（加法發光需要深色
          背景才看得清楚，樣式見 styles.css 的 .orbCanvas） */}
      <LineOrbs orbs={FIVE_SELVES} speakStateRef={idleSpeakRef} height={340} />
      <p className="gateSub">三個情境，兩個「你」彼此說服。你可以隨時介入，最後做出選擇。</p>
      <button type="button" className="btn btnPrimary" onClick={() => onLinked(linkedSession)}>
        開始體驗
      </button>
    </div>
  )
}
