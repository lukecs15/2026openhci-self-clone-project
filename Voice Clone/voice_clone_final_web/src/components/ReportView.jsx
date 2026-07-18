/**
 * ReportView.jsx — 體驗結尾的簡單報告 + take away QR
 *
 * 對應整體流程第 8 步：呈現三個情境的選擇、討論摘要、介入時的思考變化，
 * 同時把聚合結果 POST 回後端（/result），並顯示第二個 QR（手機結果頁），
 * 讓體驗者把報告帶走。
 */

import { useEffect, useRef, useState } from 'react'
import { mobileResultUrl, postOnboardingResult, qrImageUrl } from '../api/onboardingClient'
import { buildResultPayload } from '../utils/report'

export default function ReportView({ sessionId, session, records, onRestart }) {
  const [postState, setPostState] = useState('posting') // posting | done | error
  const [postError, setPostError] = useState('')
  const postedRef = useRef(false)
  const payloadRef = useRef(null)

  if (!payloadRef.current) {
    payloadRef.current = buildResultPayload(records, session)
  }
  const payload = payloadRef.current

  useEffect(() => {
    if (postedRef.current) return
    postedRef.current = true
    postOnboardingResult(sessionId, payload)
      .then(() => setPostState('done'))
      .catch((err) => {
        setPostState('error')
        setPostError(err.message)
      })
  }, [sessionId, payload])

  return (
    <div className="report">
      <h2 className="reportTitle">你的內在對話報告</h2>
      <p className="reportClosing">{payload.summary_text}</p>

      <div className="reportCards">
        {payload.scenarios.map((s, i) => (
          <section key={s.scenario_id} className="reportCard">
            <div className="stageKicker">情境 {i + 1}</div>
            <h3 className="reportCardTitle">{s.title}</h3>
            <dl className="reportFields">
              <div>
                <dt>你的選擇</dt>
                <dd className="reportChoice">{s.choice_label || '（未選擇）'}</dd>
              </div>
              <div>
                <dt>討論摘要</dt>
                <dd>{s.summary}</dd>
              </div>
              <div>
                <dt>你介入時的思考</dt>
                <dd>{s.intervention_reflection}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>

      <div className="reportQrSection">
        <h3>把這份報告帶走</h3>
        <div className="qrBox qrBoxSmall">
          <img src={qrImageUrl(mobileResultUrl(sessionId), 360)} alt="掃碼在手機上領取你的報告" width={220} height={220} />
        </div>
        <p className="gateHintSmall">
          {postState === 'posting' && '正在為你封存這份報告…'}
          {postState === 'done' && '用手機掃描，隨時回顧這場與自己的對話'}
          {postState === 'error' && `報告上傳失敗（${postError}），請呼叫工作人員`}
        </p>
      </div>

      <button type="button" className="btn" onClick={onRestart}>
        結束體驗（下一位）
      </button>
    </div>
  )
}
