/**
 * OnboardingFlow.jsx — 手機端主流程：歡迎 → Big Five 問卷 → 錄音 → 連結上傳
 *
 * 流程順序（修過的設計錯誤，見檔案下方說明）：使用者先在手機上「獨立」
 * 填完問卷、錄好聲音樣本，完全不需要 session id；只有到最後「連結上傳」
 * 這一步，才需要取得 session id——用手機相機掃主系統畫面上的 QR code
 * （見 components/QrScanner.jsx），或直接手動輸入，兩種方式都可以。取得
 * session id 後才真的呼叫 POST /api/onboarding-sessions/{id}/link 把問卷
 * 分數 + 聲音樣本一次送出。桌機那邊輪詢到 status=linked 就會自動載入這裡
 * 生成的 5 位「自我」agent（見 voice_clone_frontend/components/
 * OnboardingLinkGate.jsx）。
 *
 * ── 修過的設計錯誤 ──────────────────────────────────────────────────────
 * 第一版把「輸入/掃描 session id」放在最前面（歡迎頁就要求要有 session id
 * 才能開始填問卷），這樣的假設是「使用者掃了桌機的 QR 才會打開這個網站」。
 * 但實際規劃的流程是反過來：使用者可能提早、甚至不在桌機前就先把問卷填完
 * （例如排隊等待時），填完才需要找到桌機、掃碼把資料傳過去建立連結——
 * session id 應該只在最後「連結上傳」這一步才需要，不該卡在流程最前面。
 *
 * 步驟狀態機（純粹用 React state 管理，這幾個步驟不需要各自獨立的網址，
 * 使用者中途重新整理頁面本來就會回到起點，跟填一般問卷網站的體驗一致）：
 *   welcome → questionnaire → record → connect → submitting → done → result-scan
 *                                                            └→ error（可重試）
 *
 * ── 修過的問題：result-scan 這一步為什麼要在 app 裡自己掃，不能靠手機系統相機 ──
 * 體驗結束後，桌機會顯示第二個 QR code（見 voice_clone_frontend 的
 * ResultQrOverlay），內容是 `<桌機端設定的 VITE_MOBILE_FRONTEND_URL>/result?session=<id>`。
 * 如果讓使用者離開這個 app、直接用手機系統相機掃，瀏覽器會照著 QR 裡烘焙
 * 死的那個網域開網頁——桌機那份 .env 沒跟著換過（例如用 cloudflared 每次
 * 重啟網域都會變，或桌機端根本忘了設）時，就會導到打不開的
 * `http://localhost:5175/...`（這正是使用者實測回報的狀況）。
 * 解法：在這支 app 裡自己掃（重用 components/QrScanner.jsx），掃到文字後
 * 只用 utils/sessionLink.js 的 extractSessionIdFromScannedText() 取出
 * `session` 這個 query 參數值，網域本身直接丟棄不用；再用
 * window.location.assign 導到「這個 app 自己所在的來源」的 /result?session=…
 * ——不管 QR 裡烘焙的網域對不對，最後一定是導到使用者手機當下真正打得開的
 * 那個網址，從根本避開「QR 網域設定錯誤/沒更新」這整類問題。
 */

import { useMemo, useRef, useState } from 'react'
import { BIG_FIVE_QUESTIONS } from '../data/bigFiveQuestions'
import { computeBigFiveScores, isQuestionnaireComplete } from '../store/questionnaireFlow'
import { linkOnboardingSession } from '../api/onboardingClient'
import { extractSessionIdFromScannedText } from '../utils/sessionLink'
import LikertQuestion from '../components/LikertQuestion'
import ProgressBar from '../components/ProgressBar'
import QrScanner from '../components/QrScanner'
import {
  pageStyle,
  containerStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  cardStyle,
  colors,
} from '../styles/theme'

export default function OnboardingFlow() {
  const [sessionId, setSessionId] = useState('')
  const [connectMode, setConnectMode] = useState('scan') // 'scan' | 'manual'
  const [step, setStep] = useState('welcome') // welcome | questionnaire | record | connect | submitting | done | result-scan | error
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [linkedAgents, setLinkedAgents] = useState([])
  const [transitioning, setTransitioning] = useState(false)
  const [showIncompleteWarning, setShowIncompleteWarning] = useState(false)
  const [resultConnectMode, setResultConnectMode] = useState('scan') // 'scan' | 'manual'
  const [resultSessionInput, setResultSessionInput] = useState('')

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)

  const scores = useMemo(() => computeBigFiveScores(BIG_FIVE_QUESTIONS, answers), [answers])
  const currentQuestion = BIG_FIVE_QUESTIONS[questionIndex]
  const isLastQuestion = questionIndex === BIG_FIVE_QUESTIONS.length - 1

  const handleAnswer = (value) => {
    // 防止 180ms 自動跳題的過渡期間被重複觸發：手速快、在同一題上連點兩下
    // 的話，舊版邏輯會讓 setQuestionIndex 被排程兩次、一次跳兩題，中間跳過
    // 的那一題就永遠不會被記錄進 answers。這會讓最後一題的「完成問卷」按鈕
    // 因為 isQuestionnaireComplete() 永遠是 false 而被停用，使用者感覺就像
    // 「按了完全沒反應」——這正是使用者回報的 bug。用 transitioning 擋掉
    // 過渡期間的重複作答/切題即可修掉。
    if (transitioning) return
    const nextAnswers = { ...answers, [currentQuestion.id]: value }
    setAnswers(nextAnswers)
    if (!isLastQuestion) {
      // 選完自動跳下一題，減少手機上的點擊次數；最後一題刻意不自動跳走，
      // 讓使用者可以看到「完成問卷」的明確按鈕，知道這一段結束了。
      setTransitioning(true)
      setTimeout(() => {
        setQuestionIndex((i) => i + 1)
        setTransitioning(false)
      }, 180)
    }
  }

  const handlePrevQuestion = () => {
    if (transitioning) return
    setShowIncompleteWarning(false)
    setQuestionIndex((i) => Math.max(0, i - 1))
  }

  // 完成問卷按鈕故意不用 HTML disabled 屬性擋（disabled 的 <button> 完全不會
  // 觸發 click 事件，按下去會像「沒有反應」一樣，之前使用者回報的 bug就是
  // 這樣來的）。改成一律可以點，點下去才檢查有沒有全部作答：沒有就顯示提示
  // 文字告訴使用者還缺幾題，而不是一開始就跳出來（那樣在使用者還沒按下去
  // 之前就顯示警告，體驗上更奇怪）。
  const handleFinishQuestionnaire = () => {
    if (isQuestionnaireComplete(BIG_FIVE_QUESTIONS, answers)) {
      setShowIncompleteWarning(false)
      setStep('record')
    } else {
      setShowIncompleteWarning(true)
    }
  }

  const startRecording = async () => {
    setErrorMessage('')
    try {
      // Safari（尤其是 iOS）對 getUserMedia／MediaRecorder 的支援跟 Chrome
      // 不太一樣：非安全情境（不是 https 或 localhost）會直接拒絕權限要求、
      // 舊版 Safari 甚至沒有 window.MediaRecorder。原本這裡完全沒有
      // try/catch，getUserMedia 一 reject（例如權限被擋）整個 async function
      // 就直接中斷、isRecording 永遠不會變成 true——畫面上完全看不出任何
      // 變化，這正是「按下開始錄音沒有反應」的原因。現在改成明確 catch 起來
      // 並用 errorMessage 顯示給使用者看。
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error(
          '這個瀏覽器/連線環境不支援錄音（getUserMedia 無法使用）。iOS Safari 需要用 https 或 localhost 開啟頁面才能用麥克風，用區網 IP + http 通常會被瀏覽器擋掉。'
        )
      }
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('這個瀏覽器不支援 MediaRecorder 錄音功能，請改用其他瀏覽器（如 Chrome）測試。')
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // 不強制指定 mimeType（讓瀏覽器選自己支援的），事後用 recorder 實際
      // 採用的 mimeType 組 Blob，避免 Safari 常見的「錄出來是 audio/mp4，
      // 但檔案類型被硬寫成 audio/webm」的落差。
      const preferredMimeTypes = ['audio/webm', 'audio/mp4', 'audio/aac', 'audio/wav']
      const supportedMimeType = preferredMimeTypes.find(
        (type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type)
      )
      const recorder = supportedMimeType
        ? new MediaRecorder(stream, { mimeType: supportedMimeType })
        : new MediaRecorder(stream)

      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onerror = (e) => {
        setErrorMessage((e.error && e.error.message) || '錄音時發生錯誤，請重新嘗試')
        setIsRecording(false)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        setAudioBlob(blob)
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(blob)
        })
        streamRef.current?.getTracks().forEach((t) => t.stop())
      }
      recorder.start()
      mediaRecorderRef.current = recorder
      setIsRecording(true)
    } catch (err) {
      setIsRecording(false)
      if (err && err.name === 'NotAllowedError') {
        setErrorMessage('沒有取得麥克風權限，請到瀏覽器/系統設定允許這個網站使用麥克風後再試一次。')
      } else if (err && err.name === 'NotFoundError') {
        setErrorMessage('找不到可用的麥克風裝置，請確認手機麥克風正常。')
      } else {
        setErrorMessage((err && err.message) || '無法啟動錄音，請確認瀏覽器權限與網路連線。')
      }
    }
  }

  const stopRecording = () => {
    mediaRecorderRef.current?.stop()
    setIsRecording(false)
  }

  const handleReRecord = () => {
    setAudioBlob(null)
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
  }

  const handleQrDecoded = (scannedText) => {
    const parsed = extractSessionIdFromScannedText(scannedText)
    setSessionId(parsed)
    setConnectMode('manual') // 掃到後切到手動輸入畫面，讓使用者可以看到/確認解析出來的值再送出
  }

  const handleResultQrDecoded = (scannedText) => {
    // 只取 session id，QR 裡烘焙的網域本身不使用（見檔案開頭「result-scan
    // 為什麼要在 app 裡自己掃」的說明）。
    const parsed = extractSessionIdFromScannedText(scannedText)
    setResultSessionInput(parsed)
    setResultConnectMode('manual') // 讓使用者可以看到/確認解析出來的值再前往
  }

  const handleGoToResult = () => {
    if (!resultSessionInput) {
      setErrorMessage('還沒有結果代碼，請先掃描主系統畫面上的第二個 QR code 或手動輸入')
      return
    }
    // 刻意用「這個 app 目前所在的來源」組網址（相對路徑），不是照抄 QR
    // 裡的網域——這樣就算桌機端的 QR 網域設定錯誤/沒更新，手機這邊還是
    // 會導到自己打得開的網址。
    window.location.assign(`/result?session=${encodeURIComponent(resultSessionInput)}`)
  }

  const handleSubmit = async () => {
    if (!sessionId) {
      setErrorMessage('還沒有連結代碼（session id），請先掃描 QR code 或手動輸入')
      return
    }
    if (!audioBlob) {
      setErrorMessage('還沒有錄音樣本，請回到上一步錄音')
      return
    }

    setErrorMessage('')
    setStep('submitting')
    try {
      const session = await linkOnboardingSession(sessionId, scores, audioBlob)
      setLinkedAgents(session.agents || [])
      setStep('done')
    } catch (err) {
      setErrorMessage(err.message || '連結失敗，請稍後再試')
      setStep('error')
    }
  }

  return (
    <div style={pageStyle}>
      <header style={{ padding: '1.25rem 1.25rem 0' }}>
        <h1 style={{ margin: 0, fontSize: '1.05rem' }}>自我對話 — 人格問卷與聲音克隆</h1>
      </header>

      <div style={containerStyle}>
        {step === 'welcome' && <WelcomeStep onStart={() => setStep('questionnaire')} />}

        {step === 'questionnaire' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <ProgressBar current={questionIndex + 1} total={BIG_FIVE_QUESTIONS.length} />
            <LikertQuestion
              text={currentQuestion.text}
              value={answers[currentQuestion.id]}
              onAnswer={handleAnswer}
            />
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={handlePrevQuestion} disabled={questionIndex === 0} style={secondaryButtonStyle}>
                上一題
              </button>
              {isLastQuestion && (
                <button onClick={handleFinishQuestionnaire} style={primaryButtonStyle(true)}>
                  完成問卷，下一步錄音
                </button>
              )}
            </div>
            {isLastQuestion && showIncompleteWarning && !isQuestionnaireComplete(BIG_FIVE_QUESTIONS, answers) && (
              <p style={{ margin: 0, fontSize: '0.78rem', color: colors.danger }}>
                還有 {BIG_FIVE_QUESTIONS.filter((q) => answers[q.id] === undefined || answers[q.id] === null).length}{' '}
                題尚未作答（可能是手速太快跳過了），請點「上一題」回去檢查每一題都已選擇答案。
              </p>
            )}
          </div>
        )}

        {step === 'record' && (
          <RecordStep
            isRecording={isRecording}
            audioUrl={audioUrl}
            errorMessage={errorMessage}
            onStart={startRecording}
            onStop={stopRecording}
            onReRecord={handleReRecord}
            onNext={() => setStep('connect')}
          />
        )}

        {step === 'connect' && (
          <ConnectStep
            sessionId={sessionId}
            onSessionIdChange={setSessionId}
            mode={connectMode}
            onModeChange={setConnectMode}
            onDecoded={handleQrDecoded}
            onSubmit={handleSubmit}
            errorMessage={errorMessage}
          />
        )}

        {step === 'submitting' && (
          <div style={{ textAlign: 'center', padding: '2rem 0' }}>
            <p style={{ color: colors.textMuted }}>上傳中，正在建立你的聲音克隆與 5 位自我 agent…</p>
          </div>
        )}

        {step === 'done' && (
          <DoneStep agents={linkedAgents} onViewResult={() => setStep('result-scan')} />
        )}

        {step === 'result-scan' && (
          <ResultScanStep
            sessionId={resultSessionInput}
            onSessionIdChange={setResultSessionInput}
            mode={resultConnectMode}
            onModeChange={setResultConnectMode}
            onDecoded={handleResultQrDecoded}
            onSubmit={handleGoToResult}
            onBack={() => setStep('done')}
            errorMessage={errorMessage}
          />
        )}

        {step === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ color: colors.danger }}>{errorMessage}</p>
            <button onClick={() => setStep('connect')} style={primaryButtonStyle(true)}>
              返回重試
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function WelcomeStep({ onStart }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={cardStyle}>
        <p style={{ margin: 0, lineHeight: 1.7, color: colors.textMuted }}>
          接下來會請你填寫一份簡短的人格問卷（Big Five 五大人格），並錄一段
          3~10 秒的聲音樣本。完成後，到主系統前用相機掃描畫面上的 QR
          code（或手動輸入代碼）即可上傳，系統會依你的問卷結果生成 5 位
          「自我」agent（開放性 / 盡責性 / 外向性 / 親和性 / 負面情緒），
          都會用你剛剛克隆的聲音回覆，可以在主系統畫面選其中 2 位進行
          自我省思辯論。
        </p>
      </div>
      <button onClick={onStart} style={primaryButtonStyle(true)}>
        開始填寫問卷
      </button>
    </div>
  )
}

function RecordStep({ isRecording, audioUrl, errorMessage, onStart, onStop, onReRecord, onNext }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={cardStyle}>
        <p style={{ margin: 0, lineHeight: 1.7, color: colors.textMuted }}>
          請在安靜的環境錄一段 3~10 秒的清晰語音（念一段話即可，內容不限），
          這段聲音會用來克隆你的音色，5 位自我 agent 對話時都會用這個聲音
          回覆。
        </p>
      </div>

      {errorMessage && !audioUrl && (
        <p style={{ margin: 0, fontSize: '0.8rem', color: colors.danger }}>{errorMessage}</p>
      )}

      {!audioUrl ? (
        <>
          <button
            onClick={isRecording ? onStop : onStart}
            style={{
              ...primaryButtonStyle(true),
              background: isRecording ? colors.danger : colors.accent,
            }}
          >
            {isRecording ? '停止錄音' : '開始錄音'}
          </button>
          {isRecording && (
            <p style={{ margin: 0, fontSize: '0.8rem', color: colors.accentSoft, textAlign: 'center' }}>
              ● 錄音中…請對著麥克風說話，說完按「停止錄音」
            </p>
          )}
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={audioUrl} controls style={{ width: '100%' }} />
          <button onClick={onReRecord} style={secondaryButtonStyle}>
            重新錄音
          </button>
          <button onClick={onNext} style={primaryButtonStyle(true)}>
            下一步：連結上傳
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * ConnectStep — 問卷+錄音都完成後，最後一步：取得 session id 並上傳。
 * 'scan' 模式用手機相機即時掃 QR code；'manual' 模式（含掃描成功後自動
 * 切換過來，方便使用者確認/修改解析出來的值）是純文字輸入框。兩種模式
 * 可以隨時互相切換，不會遺失已經輸入/掃到的 sessionId。
 */
function ConnectStep({ sessionId, onSessionIdChange, mode, onModeChange, onDecoded, onSubmit, errorMessage }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={cardStyle}>
        <p style={{ margin: 0, lineHeight: 1.7, color: colors.textMuted }}>
          問卷與聲音樣本都準備好了。最後一步：在主系統前掃描畫面上的 QR
          code（或手動輸入代碼），把資料上傳連結到那場對話。
        </p>
      </div>

      {mode === 'scan' ? (
        <>
          <QrScanner onDecode={onDecoded} />
          <button onClick={() => onModeChange('manual')} style={secondaryButtonStyle}>
            改用手動輸入
          </button>
        </>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.85rem', color: colors.textMuted }}>
            連結代碼（session id）
            <input
              value={sessionId}
              onChange={(e) => onSessionIdChange(e.target.value.trim())}
              placeholder="貼上或輸入主系統畫面上顯示的代碼"
              style={{
                padding: '0.6rem 0.75rem',
                borderRadius: '0.5rem',
                border: `1px solid ${colors.border}`,
                background: colors.card,
                color: colors.text,
              }}
            />
          </label>
          <button onClick={() => onModeChange('scan')} style={secondaryButtonStyle}>
            改用相機掃描 QR code
          </button>
        </>
      )}

      {errorMessage && <p style={{ margin: 0, fontSize: '0.8rem', color: colors.danger }}>{errorMessage}</p>}

      <button onClick={onSubmit} disabled={!sessionId} style={primaryButtonStyle(!!sessionId)}>
        上傳並連結
      </button>
    </div>
  )
}

function DoneStep({ agents, onViewResult }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}>
      <div style={cardStyle}>
        <p style={{ margin: 0, fontSize: '1.05rem', color: colors.accentSoft }}>連結成功！</p>
        <p style={{ margin: '0.6rem 0 0', color: colors.textMuted, lineHeight: 1.7 }}>
          請回到主系統畫面繼續，稍後即可選擇兩位「自我」agent 開始辯論。
        </p>
      </div>

      {agents.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {agents.map((agent) => (
            <li
              key={agent.agent_id}
              style={{
                ...cardStyle,
                padding: '0.75rem 1rem',
                textAlign: 'left',
                fontSize: '0.85rem',
              }}
            >
              <strong>{agent.display_name}</strong>
              {agent.role_tag && <span style={{ color: colors.textFaint }}> ・ {agent.role_tag}</span>}
            </li>
          ))}
        </ul>
      )}

      <p style={{ margin: 0, fontSize: '0.75rem', color: colors.textFaint }}>
        體驗結束後，主系統會顯示第二個 QR code。不用切去手機的相機
        app——直接在這裡按下面的按鈕，用這支 app 自己掃就好。
      </p>

      <button onClick={onViewResult} style={primaryButtonStyle(true)}>
        體驗結束了，掃描第二個 QR code 查看結果
      </button>
    </div>
  )
}

/**
 * ResultScanStep — 體驗結束後，掃桌機第二個 QR code（或手動輸入結果代碼）。
 * 跟 ConnectStep 是同一套 UI 模式（scan/manual 互相切換、掃到後自動切到
 * manual 讓使用者確認），差別在按下按鈕後不是呼叫後端 API，而是直接
 * window.location.assign 導到這支 app 自己的 /result 頁面（見
 * handleGoToResult 的說明：不採用 QR 裡烘焙的網域）。
 */
function ResultScanStep({ sessionId, onSessionIdChange, mode, onModeChange, onDecoded, onSubmit, onBack, errorMessage }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={cardStyle}>
        <p style={{ margin: 0, lineHeight: 1.7, color: colors.textMuted }}>
          在主系統前掃描結束畫面上顯示的第二個 QR code（或手動輸入代碼），
          就能在這支手機上看到融合波形與總結紀念語。
        </p>
      </div>

      {mode === 'scan' ? (
        <>
          <QrScanner onDecode={onDecoded} />
          <button onClick={() => onModeChange('manual')} style={secondaryButtonStyle}>
            改用手動輸入
          </button>
        </>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.85rem', color: colors.textMuted }}>
            結果代碼（session id）
            <input
              value={sessionId}
              onChange={(e) => onSessionIdChange(e.target.value.trim())}
              placeholder="貼上或輸入主系統畫面上顯示的代碼"
              style={{
                padding: '0.6rem 0.75rem',
                borderRadius: '0.5rem',
                border: `1px solid ${colors.border}`,
                background: colors.card,
                color: colors.text,
              }}
            />
          </label>
          <button onClick={() => onModeChange('scan')} style={secondaryButtonStyle}>
            改用相機掃描 QR code
          </button>
        </>
      )}

      {errorMessage && <p style={{ margin: 0, fontSize: '0.8rem', color: colors.danger }}>{errorMessage}</p>}

      <button onClick={onSubmit} disabled={!sessionId} style={primaryButtonStyle(!!sessionId)}>
        查看結果
      </button>
      <button onClick={onBack} style={secondaryButtonStyle}>
        返回上一步
      </button>
    </div>
  )
}
