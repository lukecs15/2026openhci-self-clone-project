/**
 * OnboardingFlow.jsx — 手機端主流程（「心智最高法院」法庭審訊主題）
 *
 * 這份檔案的視覺設計對應使用者提供的設計稿（見 styles/court.css 開頭的
 * 移植說明，目前是第二版設計稿「內在法庭_手機問卷 (4).html」），但整個
 * 功能流程/state machine 跟改版之前完全一樣，只是重新蒙皮：
 *
 *   opening（開場，見 components/CourtOpening.jsx）
 *     → welcome（電子傳票 / 刑事傳喚通知書，對應設計稿「1|電子傳票」，
 *       v2 改成公文格式）
 *     → questionnaire（審訊，對應設計稿「2|審訊」，15 題 BFI-2-XS）
 *     → record（口述證詞，對應設計稿「3|口述證詞」）
 *     → connect（移送聯繫——設計稿沒有這一步，是這個 app 既有的功能：
 *       掃 QR / 手動輸入 session id，把問卷+錄音上傳連結到主系統的對話）
 *     → submitting → done（強制移送，對應設計稿「4|強制移送」，多加了
 *       「查看結果」的入口）
 *     → result-scan（設計稿沒有，既有功能：體驗結束後掃第二個 QR 查看
 *       融合波形+總結）
 *                                                       └→ error（可重試）
 *
 * v2 改版重點（跟第一版 inner-court-survey-fix8.html 比對後的差異，逐一
 * 核對過套用進來）：
 *   - 電子傳票整個改成公文格式（docMeta/docCourt/docRule/docTitle/
 *     docFields/docBody/docFoot），新增 docDate（發文日期，格式「心智紀元
 *     YYYY 年 M 月 D 日」）；caseNo 沿用同一組「YYYY-XXXX」格式，只是顯示
 *     位置換成「發文字號:心智法庭傳字第 XXXX 號」。
 *   - 震動回饋（buzz）整個拿掉：v2 設計稿把 buzz() 函式定義跟所有呼叫點都
 *     刪了，這裡跟著拿掉（utils/courtFeedback.js 也移除了這個函式）。
 *   - 答對選項的 flash 光暈改成依「這一題屬於哪個 OCEAN 向度」動態上色
 *     （lawyerEvent 多帶一個 dim 欄位，TrialStep 用它算出 --fc/--fcSoft
 *     兩個 CSS 自訂屬性，注入到剛點擊的按鈕上），不再是固定的暗紅色。
 *   - 審訊/傳票畫面新增 bgWash 背景層（五顆漂移的 OCEAN 粉彩色斑）。
 *   - 審訊題目泡泡切換不再有進場動畫（拿掉 bubble.switching / qIn），
 *     跟著拿掉這裡對應的 class。
 *   - 口供錄音完成按鈕（tmDone）從「CSS class 控制 show/hide」改成單純
 *     用 React 條件渲染（audioUrl && !isRecording 才掛載到 DOM），效果
 *     跟設計稿新版「display:none ↔ block」的直接切換相同，只是用更符合
 *     React 慣例的寫法達成。
 *
 * 沿用/保留的既有修過的 bug fix（改版時特別注意沒有回歸）：
 *   - Safari 錄音相容性：startRecording 的 try/catch、getUserMedia/
 *     MediaRecorder 存在性檢查、mimeType 協商，逐字保留。
 *   - 結果 QR 網域繞開：handleResultQrDecoded 只取 QR 裡的 session id、
 *     網域本身丟棄不用，handleGoToResult 用 window.location.assign 導到
 *     「這個 app 自己所在的來源」，不管桌機端 QR 網域設定對不對都能連到。
 *   - 問卷「按下去沒反應」的舊 bug（disabled 按鈕 + 過渡期間 race
 *     condition）在這個新設計裡已經不可能發生了：答題現在採用設計稿的
 *     「點選即時同步跳下一題」設計（沒有原本那個製造出 race condition 的
 *     180ms 人工延遲視窗），完成問卷按鈕整個拿掉——因為新設計本來就沒有
 *     「跳過某一題」的路徑（一定要點答案才會前進），isQuestionnaireComplete
 *     的檢查在這個流程下永遠是 true，不需要再額外判斷/擋按鈕。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import '../styles/court.css'
import { BIG_FIVE_QUESTIONS, LIKERT_OPTIONS } from '../data/bigFiveQuestions'
import { DIMS } from '../data/oceanDims'
import { computeBigFiveScores } from '../store/questionnaireFlow'
import { linkOnboardingSession } from '../api/onboardingClient'
import { extractSessionIdFromScannedText } from '../utils/sessionLink'
import { ping, getAudioContext } from '../utils/courtFeedback'
import { hsb } from '../utils/courtVisuals'
import CourtOpening from '../components/CourtOpening'
import CourtWaves from '../components/CourtWaves'
import LawyerAvatar from '../components/LawyerAvatar'
import CourtMicVisualizer from '../components/CourtMicVisualizer'
import AgentWaveCanvas from '../components/AgentWaveCanvas'
import QrScanner from '../components/QrScanner'

// 律師點頭小語（逐字移植設計稿的 QUIPS，含標點——設計稿裡句中逗號/問號/
// 冒號一律用半形，只有頓號、句號維持全形，這裡逐字保留同一套標點風格）。
const QUIPS = [
  '請依直覺作答,不必斟酌。',
  '庭上聽得見你的猶豫。',
  '本席只記錄,不評判。',
  '每一次答辯,都會成為呈堂證供。',
  '沒有標準答案,只有你的答案。',
]

const TESTIMONY_PROMPT = '請親口說出:最近最卡關、最焦慮、或最想逃避的事——那件具體的煩惱,是什麼?'

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const s = String(totalSeconds % 60).padStart(2, '0')
  return `${m}:${s}`
}

function BgWash() {
  return (
    <div className="bgWash">
      <i />
      <i />
      <i />
      <i />
      <i />
    </div>
  )
}

export default function OnboardingFlow() {
  const [step, setStep] = useState('opening')
  const [sessionId, setSessionId] = useState('')
  const [connectMode, setConnectMode] = useState('scan') // 'scan' | 'manual'
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recTimeLabel, setRecTimeLabel] = useState('00:00')
  const [analyserNode, setAnalyserNode] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [linkedAgents, setLinkedAgents] = useState([])
  const [resultConnectMode, setResultConnectMode] = useState('scan') // 'scan' | 'manual'
  const [resultSessionInput, setResultSessionInput] = useState('')
  const [lawyerEvent, setLawyerEvent] = useState({ seq: 0, kind: null, value: null, dim: null })
  const [quip, setQuip] = useState(null)

  // 案號/發文日期只在掛載時產生一次（純裝飾用，呼應設計稿 caseNo／docDate
  // 的呈現方式）。
  const caseNo = useMemo(() => `${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`, [])
  const docDate = useMemo(() => {
    const d = new Date()
    return `心智紀元 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
  }, [])

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)
  const courtWavesRef = useRef(null)
  const lastAnswerTimeRef = useRef(0)
  const quipLockRef = useRef(false)
  const recStartRef = useRef(0)
  const recTimerIdRef = useRef(null)

  const scores = useMemo(() => computeBigFiveScores(BIG_FIVE_QUESTIONS, answers), [answers])
  const currentQuestion = BIG_FIVE_QUESTIONS[questionIndex]
  const isLastQuestion = questionIndex === BIG_FIVE_QUESTIONS.length - 1

  // 主導人格 = 分數最高的向度（訴訟代理人），對應設計稿 tmDone 的點擊邏輯。
  const dominantDim = useMemo(() => {
    let best = DIMS[0]
    let bestScore = -Infinity
    DIMS.forEach((d) => {
      const s = scores[d.trait] ?? 0
      if (s > bestScore) {
        bestScore = s
        best = d
      }
    })
    return best
  }, [scores])

  const handleAnswer = (value) => {
    // 250ms 內的重複觸發視為誤觸（同時觸控+點擊事件、手速太快連點），
    // 逐邏輯移植設計稿的 lastAnswer 防抖。因為現在是「答題即刻同步跳下一
    // 題」（沒有舊版那個 180ms 人工延遲視窗），這個防抖已經足以避免任何
    // race condition，不需要額外的 transitioning 狀態鎖。
    const now = Date.now()
    if (now - lastAnswerTimeRef.current < 250) return
    lastAnswerTimeRef.current = now

    const q = currentQuestion
    const nextAnswers = { ...answers, [q.id]: value }
    setAnswers(nextAnswers)
    ping(q.dim)
    courtWavesRef.current?.pulse(q.dim)
    // dim 欄位給 TrialStep 算 flash 光暈顏色用（v2 設計稿依當前題目所屬
    // 向度動態上色，不再是固定的暗紅色）。
    setLawyerEvent((prev) => ({ seq: prev.seq + 1, kind: 'answer', value, dim: q.dim }))

    if (isLastQuestion) {
      // 最後一題留 700ms 讓律師反應動畫播完，再切到口述證詞畫面（逐邏輯
      // 移植設計稿 answer() 函式的同一個延遲）。
      setTimeout(() => setStep('record'), 700)
    } else {
      setQuestionIndex((i) => i + 1)
    }
  }

  const handlePrevQuestion = () => {
    setQuestionIndex((i) => Math.max(0, i - 1))
  }

  const handleLawyerTap = () => {
    if (step !== 'questionnaire' || quipLockRef.current) return
    quipLockRef.current = true
    setLawyerEvent((prev) => ({ seq: prev.seq + 1, kind: 'tap', value: null, dim: null }))
    setQuip(QUIPS[Math.floor(Math.random() * QUIPS.length)])
    setTimeout(() => {
      setQuip(null)
      quipLockRef.current = false
    }, 1800)
  }

  const startRecording = async () => {
    setErrorMessage('')
    try {
      // Safari（尤其是 iOS）對 getUserMedia／MediaRecorder 的支援跟 Chrome
      // 不太一樣：非安全情境（不是 https 或 localhost）會直接拒絕權限要求、
      // 舊版 Safari 甚至沒有 window.MediaRecorder。這裡明確 catch 起來並用
      // errorMessage 顯示給使用者看（見改版前的除錯記錄）。
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

      // 即時波形視覺化（components/CourtMicVisualizer.jsx）用的
      // AnalyserNode：跟 ping() 共用同一個全域 AudioContext（見
      // utils/courtFeedback.js 的 getAudioContext()），不需要另外開一個，
      // 逐邏輯對應設計稿 recBtn 點擊處理裡建立 analyser 的方式。分析器建立
      // 失敗不影響錄音本身能不能動作，只是少了視覺化，所以這段包在錄音
      // try/catch 裡但不因為它失敗就中斷整個錄音流程。
      try {
        const audioCtx = getAudioContext()
        if (audioCtx) {
          if (audioCtx.state === 'suspended') audioCtx.resume()
          const source = audioCtx.createMediaStreamSource(stream)
          const analyser = audioCtx.createAnalyser()
          analyser.fftSize = 512
          source.connect(analyser)
          setAnalyserNode(analyser)
        }
      } catch {
        setAnalyserNode(null)
      }

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
      recStartRef.current = Date.now()
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
    setAnalyserNode(null)
  }

  // 錄音計時器：跟 CourtMicVisualizer 的 canvas rAF 迴圈分開管理，各自獨立
  // 更新自己負責的畫面（時間文字 vs 波形），互不依賴。
  useEffect(() => {
    if (!isRecording) {
      if (recTimerIdRef.current) {
        clearInterval(recTimerIdRef.current)
        recTimerIdRef.current = null
      }
      return undefined
    }
    recTimerIdRef.current = setInterval(() => {
      setRecTimeLabel(formatElapsed(Date.now() - recStartRef.current))
    }, 250)
    return () => {
      if (recTimerIdRef.current) {
        clearInterval(recTimerIdRef.current)
        recTimerIdRef.current = null
      }
    }
  }, [isRecording])

  const handleReRecord = () => {
    setAudioBlob(null)
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
    setRecTimeLabel('00:00')
  }

  const handleQrDecoded = (scannedText) => {
    const parsed = extractSessionIdFromScannedText(scannedText)
    setSessionId(parsed)
    setConnectMode('manual') // 掃到後切到手動輸入畫面，讓使用者可以看到/確認解析出來的值再送出
  }

  const handleResultQrDecoded = (scannedText) => {
    // 只取 session id，QR 裡烘焙的網域本身不使用（見檔案開頭「結果 QR
    // 網域繞開」的說明）。
    const parsed = extractSessionIdFromScannedText(scannedText)
    setResultSessionInput(parsed)
    setResultConnectMode('manual')
  }

  const handleGoToResult = () => {
    if (!resultSessionInput) {
      setErrorMessage('還沒有結果代碼，請先掃描主系統畫面上的第二個 QR code 或手動輸入')
      return
    }
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
    <div className="court-app">
      {step === 'opening' && <CourtOpening onEnter={() => setStep('welcome')} />}

      {step === 'welcome' && (
        <SummonsStep
          caseNo={caseNo}
          docDate={docDate}
          onEnter={() => {
            ping('C')
            setStep('questionnaire')
          }}
        />
      )}

      {step === 'questionnaire' && (
        <TrialStep
          courtWavesRef={courtWavesRef}
          answers={answers}
          questionIndex={questionIndex}
          currentQuestion={currentQuestion}
          lawyerEvent={lawyerEvent}
          quip={quip}
          onAnswer={handleAnswer}
          onPrev={handlePrevQuestion}
          onLawyerTap={handleLawyerTap}
        />
      )}

      {step === 'record' && (
        <TestimonyStep
          isRecording={isRecording}
          audioUrl={audioUrl}
          recTimeLabel={recTimeLabel}
          analyserNode={analyserNode}
          errorMessage={errorMessage}
          onStart={startRecording}
          onStop={stopRecording}
          onReRecord={handleReRecord}
          onDone={() => setStep('connect')}
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
        <div className="court-step transfer">
          <div className="tfTitle serif">移送中…</div>
          <div className="tfBody">
            <p>正在建立你的聲音克隆與 5 位自我 agent。</p>
          </div>
        </div>
      )}

      {step === 'done' && (
        <TransferDoneStep dominantDim={dominantDim} linkedAgents={linkedAgents} onViewResult={() => setStep('result-scan')} />
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
        <div className="court-step transfer">
          <div className="warn mono">FINAL NOTICE</div>
          <p className="tfBody" style={{ color: 'var(--seal)' }}>
            {errorMessage}
          </p>
          <button type="button" className="btn enter" onClick={() => setStep('connect')}>
            返回重試
          </button>
        </div>
      )}
    </div>
  )
}

/** 1|電子傳票 — 刑事傳喚通知書（v2 設計稿改成公文格式，對應「summons」畫面）。 */
function SummonsStep({ caseNo, docDate, onEnter }) {
  return (
    <div className="court-step summons scroll">
      <BgWash />
      <div className="doc">
        <div className="docMeta mono">
          檔　　號:PSY-INT
          <br />
          保存年限:永久
        </div>
        <div className="docCourt serif">心智最高法院</div>
        <div className="docRule" />
        <div className="docTitle serif">刑事傳喚通知書</div>
        <div className="docFields">
          <div>
            受文者:<b>本人</b>
          </div>
          <div>發文日期:{docDate}</div>
          <div>
            發文字號:心智法庭傳字第 <span className="mono">{caseNo}</span> 號
          </div>
          <div>速　　別:最速件</div>
          <span className="seal serif">傳喚</span>
        </div>
        <div className="docBody serif">
          <p>
            <b>主旨:</b>涉案人因近期陷入嚴重內耗與思考反芻,涉嫌違反《心智健康保護法》之「過度自我摧殘罪」,依法傳喚到庭應訊,請查照。
          </p>
          <p>
            <b>說明:</b>
          </p>
          <p className="li">一、正式開庭審理前,本庭偵查官將對涉案人執行「心智基因定序」,以釐清體內失控之思緒特質。</p>
          <p className="li">二、涉案人應就以下十五項行為指控如實招供,所述內容均將成為呈堂證供。</p>
        </div>
        <div className="docFoot">
          <div className="mono docCopy">正本:涉案人本人　副本:內在法庭合議庭</div>
          <div className="docOrg serif">心智最高法院　內在法庭</div>
        </div>
      </div>
      <button type="button" className="btn enter" onClick={onEnter}>
        簽 收 應 訊
      </button>
    </div>
  )
}

/** 2|審訊 — Big Five 問卷（對應設計稿「trial」畫面）。 */
function TrialStep({ courtWavesRef, answers, questionIndex, currentQuestion, lawyerEvent, quip, onAnswer, onPrev, onLawyerTap }) {
  return (
    <div className="court-step trial scroll">
      <BgWash />
      <CourtWaves ref={courtWavesRef} answers={answers} />
      <div className="dots">
        {BIG_FIVE_QUESTIONS.map((q, i) => (
          <i key={q.id} className={i < questionIndex ? 'done' : ''} />
        ))}
      </div>
      <div className="trialHead">
        <span className="serif">審訊・心智基因定序</span>
        <span className="mono">
          {questionIndex > 0 && (
            <button
              type="button"
              onClick={onPrev}
              style={{
                marginRight: '0.9em',
                background: 'none',
                border: 'none',
                color: 'var(--ink-dim)',
                font: 'inherit',
                letterSpacing: 'inherit',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              ← 上一題
            </button>
          )}
          證據 {questionIndex + 1} / {BIG_FIVE_QUESTIONS.length}
        </span>
      </div>
      <div className="stage">
        <LawyerAvatar key={lawyerEvent.seq} event={lawyerEvent} onTap={onLawyerTap} />
        <div className="bubble" key={quip ? `quip-${lawyerEvent.seq}` : currentQuestion.id}>
          <div className="evidenceTag mono">
            {quip ? '偵查官' : `指控證據 ${String(questionIndex + 1).padStart(2, '0')}`}
          </div>
          <div className="qText">{quip || currentQuestion.text}</div>
        </div>
      </div>
      <div className="answers">
        {LIKERT_OPTIONS.map((opt) => {
          // 剛答的那個選項短暫閃一下（.ans.flash，逐邏輯移植設計稿的點擊
          // 反饋）。用 key 帶入 lawyerEvent.seq：就算連續兩次點同一個選項
          // （不同題但同一個 value），key 還是會變，animation 才會重新播放
          // 一次，而不是只在第一次點擊時生效。
          const isFlashing = lawyerEvent.kind === 'answer' && lawyerEvent.value === opt.value
          // v2 設計稿:flash 光暈依「這一題屬於哪個 OCEAN 向度」動態上色
          // （--fc/--fcSoft 自訂屬性），不再是固定的暗紅色。
          const flashDim = isFlashing ? DIMS.find((d) => d.key === lawyerEvent.dim) : null
          const style = flashDim
            ? { '--lv': opt.value, '--fc': `hsla(${flashDim.hue}, 92%, 58%, .9)`, '--fcSoft': `hsla(${flashDim.hue}, 92%, 62%, .35)` }
            : { '--lv': opt.value }
          return (
            <button
              key={isFlashing ? `ans-${opt.value}-${lawyerEvent.seq}` : `ans-${opt.value}`}
              type="button"
              className={`ans${isFlashing ? ' flash' : ''}`}
              style={style}
              onClick={() => onAnswer(opt.value)}
            >
              <span className="no mono">{opt.value}</span>
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 3|口述證詞 — 錄音（對應設計稿「testimony」畫面）。 */
function TestimonyStep({ isRecording, audioUrl, recTimeLabel, analyserNode, errorMessage, onStart, onStop, onReRecord, onDone }) {
  const isDone = Boolean(audioUrl) && !isRecording
  return (
    <div className="court-step testimony scroll">
      <div className="tmHead serif">錄口供</div>
      <div className="tmSub">案發事件口述・你的聲音將提供後續庭審使用</div>
      <div className="prompt">{TESTIMONY_PROMPT}</div>
      <CourtMicVisualizer analyserNode={analyserNode} recording={isRecording} />

      {errorMessage && !audioUrl && <p className="errorNote">{errorMessage}</p>}

      <div className="recRow">
        <button type="button" className={`recBtn${isRecording ? ' rec' : ''}`} onClick={isRecording ? onStop : onStart}>
          {isRecording ? '停止' : audioUrl ? '重新錄口供' : '開始錄口供'}
        </button>
        <span className="recTime mono">{recTimeLabel}</span>
      </div>

      {isDone && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={audioUrl} controls style={{ width: '100%' }} />
          <button type="button" className="btn secondary" onClick={onReRecord}>
            重新錄音
          </button>
        </div>
      )}

      {/* v2 設計稿把 tmDone 的顯示邏輯從「CSS class 控制 opacity/transform」
          改成單純的 display:none ↔ block；React 版用條件渲染達成一樣的
          效果（沒作好之前根本不掛載到 DOM，比切 CSS class 更直接）。 */}
      {isDone && (
        <button type="button" className="btn tmDone" onClick={onDone}>
          具結,呈交證詞
        </button>
      )}
      <div className="spacer" />
    </div>
  )
}

/**
 * 移送聯繫 — 掃 QR / 手動輸入 session id 並上傳連結（設計稿沒有這一步，
 * 是這個 app 既有的功能，沿用同一套法庭視覺語彙）。
 */
function ConnectStep({ sessionId, onSessionIdChange, mode, onModeChange, onDecoded, onSubmit, errorMessage }) {
  return (
    <div className="court-step transfer scroll">
      <div className="warn mono">FINAL NOTICE</div>
      <div className="tfTitle serif">移送聯繫</div>
      <div className="tfBody">
        <p>問卷與證詞都已備妥。最後一步:在主系統前掃描畫面上的移送代碼（或手動輸入）,把資料移送過去建立連結。</p>
      </div>

      {mode === 'scan' ? (
        <>
          <QrScanner onDecode={onDecoded} />
          <button type="button" className="btn secondary" onClick={() => onModeChange('manual')}>
            改用手動輸入
          </button>
        </>
      ) : (
        <>
          <label className="fieldLabel">
            連結代碼（session id）
            <input
              className="fieldInput"
              value={sessionId}
              onChange={(e) => onSessionIdChange(e.target.value.trim())}
              placeholder="貼上或輸入主系統畫面上顯示的代碼"
            />
          </label>
          <button type="button" className="btn secondary" onClick={() => onModeChange('scan')}>
            改用相機掃描 QR code
          </button>
        </>
      )}

      {errorMessage && <p className="errorNote">{errorMessage}</p>}

      <button type="button" className="btn enter" disabled={!sessionId} onClick={onSubmit}>
        移送並連結
      </button>
    </div>
  )
}

/** 4|強制移送 — 完成畫面（對應設計稿「transfer」畫面，多加查看結果入口）。 */
function TransferDoneStep({ dominantDim, linkedAgents, onViewResult }) {
  return (
    <div className="court-step transfer scroll">
      <div className="warn mono">FINAL NOTICE</div>
      <div className="tfTitle serif">強制移送</div>
      <div className="tfBody">
        <p>已確認將代表你出庭辯論的訴訟代理人。</p>
      </div>
      {/* 顏色逐式移植設計稿 tmDone 點擊處理的 hsb(DIMS[best].hue, 60, 88)，
          不是近似的 hsl()：HSB 的 v=88（明度）跟 HSL 的 l=88 是不同色彩模型，
          數值不能直接套用，得用同一顆 hsb() 函式換算才會拿到設計稿原本那種
          偏亮、不混黑的乾淨色。 */}
      <div className="agentLabel serif" style={{ color: hsb(dominantDim.hue, 60, 88) }}>
        訴訟代理人:{dominantDim.label}
      </div>
      <AgentWaveCanvas dim={dominantDim} />
      <div className="tfBody">
        <p>請回到主系統畫面繼續,稍後即可選擇兩位「自我」agent 開始辯論。</p>
      </div>

      {linkedAgents.length > 0 && (
        <ul className="agentList">
          {linkedAgents.map((agent) => (
            <li key={agent.agent_id}>
              <strong>{agent.display_name}</strong>
              {agent.role_tag && <span style={{ color: 'var(--ink-dim)' }}> ・ {agent.role_tag}</span>}
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="btn enter" onClick={onViewResult} style={{ marginTop: 18 }}>
        體驗結束了,掃描結果代碼
      </button>
    </div>
  )
}

/**
 * 結果傳喚 — 掃描/輸入結果代碼查看融合波形與總結（設計稿沒有這一步，是
 * 這個 app 既有的功能，沿用同一套法庭視覺語彙）。
 */
function ResultScanStep({ sessionId, onSessionIdChange, mode, onModeChange, onDecoded, onSubmit, onBack, errorMessage }) {
  return (
    <div className="court-step transfer scroll">
      <div className="tfTitle serif">結果傳喚</div>
      <div className="tfBody">
        <p>在主系統前掃描結束畫面上顯示的第二個 QR code（或手動輸入代碼）,查看融合波形與總結紀念語。</p>
      </div>

      {mode === 'scan' ? (
        <>
          <QrScanner onDecode={onDecoded} />
          <button type="button" className="btn secondary" onClick={() => onModeChange('manual')}>
            改用手動輸入
          </button>
        </>
      ) : (
        <>
          <label className="fieldLabel">
            結果代碼（session id）
            <input
              className="fieldInput"
              value={sessionId}
              onChange={(e) => onSessionIdChange(e.target.value.trim())}
              placeholder="貼上或輸入主系統畫面上顯示的代碼"
            />
          </label>
          <button type="button" className="btn secondary" onClick={() => onModeChange('scan')}>
            改用相機掃描 QR code
          </button>
        </>
      )}

      {errorMessage && <p className="errorNote">{errorMessage}</p>}

      <button type="button" className="btn enter" disabled={!sessionId} onClick={onSubmit}>
        查看結果
      </button>
      <button type="button" className="btn secondary" onClick={onBack}>
        返回上一步
      </button>
    </div>
  )
}
