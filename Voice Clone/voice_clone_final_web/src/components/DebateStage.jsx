/**
 * DebateStage.jsx — 單一情境的立場辯論舞台
 *
 * 流程（對應整體體驗的第 4~6 步）：
 *   1. 掛載即 connect + init（自訂議題 + 兩位立場 agent + 每情境回合上限），
 *      後端會立刻開始生成第一輪並「預生成下一輪」，前端播完一輪回報
 *      turn_played 才放行下一輪（低延遲控時的核心，見 hooks/useDebateSession.js）
 *   2. 兩顆立場線條球（LineOrbs）輪流「說話」——說話視覺由真實 TTS 播放
 *      能量驅動，字幕與聲音嚴格對齊（事件序列化管線）
 *   3. 使用者有 N 次（預設 3）介入機會：按下「介入討論」立刻靜音並暫停
 *      後端生成，按住說話（語音→後端 STT）或改用文字輸入，兩者收斂成
 *      同一條 user_intervene 路徑，被打斷的立場會接續回應
 *   4. 達到回合上限（debate_finished）→ 請使用者做出選擇 → end_session
 *      取得該情境的結構化 verdict（判決書）→ 回傳 onComplete 收進總報告
 *
 * ── 「跳過討論，直接選擇」提前選擇（實測回饋新增）───────────────────────
 * 介入按鈕旁的同型膠囊按鈕，但整顆高透明（隱約可見、不干擾體驗），
 * hover 才變清楚（樣式見 styles.css 的 .btnSkip）。按下後立刻靜音 +
 * pause_debate（中斷後端生成，跟介入共用同一條暫停路徑），本地
 * skipToChoice 狀態直接切到選擇面板；選完照常走 end_session → verdict。
 * 不彈窗、不確認，辯論進行中隨時可按。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import LineOrbs from './LineOrbs'
import { useDebateSession } from '../hooks/useDebateSession'
import { buildStanceAgents } from '../utils/stancePersona'
import { createWavRecorder } from '../utils/wavRecorder'

const MAX_INTERVENTIONS = Number(import.meta.env.VITE_MAX_INTERVENTIONS || 3)
const DEBATE_MAX_TURNS = Number(import.meta.env.VITE_DEBATE_MAX_TURNS || 8)

export default function DebateStage({ sessionId, session, scenario, onComplete }) {
  const {
    state,
    connect,
    disconnect,
    initDebateSession,
    pauseDebate,
    sendIntervention,
    sendInterventionAudio,
    endSession,
    getSpeakLevel,
  } = useDebateSession(sessionId)

  const agents = useMemo(() => buildStanceAgents(scenario, session), [scenario, session])
  const [choiceSide, setChoiceSide] = useState(null)
  const [skipToChoice, setSkipToChoice] = useState(false)
  const [interveneText, setInterveneText] = useState('')
  const [isHolding, setIsHolding] = useState(false)
  const [sttPending, setSttPending] = useState(false)
  const [micError, setMicError] = useState('')
  const recorderRef = useRef(null)
  const completedRef = useRef(false)

  // ── 說話視覺驅動：每幀更新 activeId + 真實播放能量（不走 React state）──
  const speakStateRef = useRef({ activeId: null, level: 0 })
  const activeIdRef = useRef(null)
  activeIdRef.current = state.activeSpeakerIds[0] || null
  useEffect(() => {
    let raf = 0
    const tick = () => {
      speakStateRef.current = { activeId: activeIdRef.current, level: getSpeakLevel() }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getSpeakLevel])

  // ── 掛載：連線 + 開始這個情境的辯論 ─────────────────────────────────
  useEffect(() => {
    connect()
    initDebateSession(scenario.topicTitle, agents, DEBATE_MAX_TURNS)
    return () => disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id])

  // ── 收到 verdict（session_summary）→ 組報告紀錄、交還給 App ──────────
  useEffect(() => {
    if (state.status !== 'summary' || completedRef.current) return
    completedRef.current = true
    const record = {
      scenarioId: scenario.id,
      title: scenario.title,
      question: scenario.question,
      topicTitle: scenario.topicTitle,
      choiceSide,
      choiceLabel: choiceSide ? scenario.choices[choiceSide].label : '',
      stanceA: scenario.choices.a,
      stanceB: scenario.choices.b,
      verdict: state.verdict,
      summaryText: state.summaryText,
      interventions: state.transcript.filter((t) => t.kind === 'user').map((t) => t.text),
      transcript: state.transcript,
      skippedToChoice: skipToChoice,
    }
    // 給結尾字幕一點停留時間再翻頁
    const timer = setTimeout(() => onComplete(record), 2600)
    return () => clearTimeout(timer)
  }, [state.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const interventionsLeft = Math.max(0, MAX_INTERVENTIONS - state.interventionCount)

  const orbs = useMemo(
    () =>
      agents.map((agent, i) => {
        const choice = scenario.choices[i === 0 ? 'a' : 'b']
        return {
          id: agent.agent_id,
          styleKey: choice.orbStyle,
          hue: choice.hue,
          label: choice.stanceName,
          subLabel: choice.shortLabel,
        }
      }),
    [agents, scenario],
  )

  // ── 提前選擇：立刻靜音 + 中斷後端生成，直接進入選擇面板 ──────────────
  const skipDiscussion = useCallback(() => {
    setSkipToChoice(true)
    pauseDebate()
  }, [pauseDebate])

  // ── 介入：語音（按住說話）──────────────────────────────────────────
  const beginHold = useCallback(async () => {
    setMicError('')
    try {
      const rec = await createWavRecorder()
      recorderRef.current = rec
      rec.start()
      setIsHolding(true)
    } catch {
      setMicError('無法使用麥克風，請改用下方文字輸入')
    }
  }, [])

  const endHold = useCallback(async () => {
    const rec = recorderRef.current
    recorderRef.current = null
    if (!rec) return
    setIsHolding(false)
    const { base64, durationMs } = await rec.stop()
    if (durationMs < 400) {
      setMicError('太短了，請按住再說一次，或改用文字輸入')
      return
    }
    setSttPending(true)
    sendInterventionAudio(base64)
  }, [sendInterventionAudio])

  // 後端回 ack（成功）或 error（辨識失敗）都解除「辨識中」
  useEffect(() => {
    if (state.status === 'ready' || state.lastError) setSttPending(false)
  }, [state.status, state.lastError])

  const submitText = useCallback(() => {
    const text = interveneText.trim()
    if (!text) return
    sendIntervention(text)
    setInterveneText('')
  }, [interveneText, sendIntervention])

  const handleChoose = useCallback(
    (side) => {
      setChoiceSide(side)
      // 選擇完成 → 結束這場辯論，後端生成這個情境的判決書（verdict）
      endSession()
    },
    [endSession],
  )

  // ── 字幕：目前最新一句（agent 或使用者）────────────────────────────
  const lastEntry = state.transcript[state.transcript.length - 1] || null
  const speakerName = (agentId) => agents.find((a) => a.agent_id === agentId)?.display_name || ''

  const showChoicePanel = (state.status === 'finished' || skipToChoice) && !choiceSide
  const waitingVerdict =
    choiceSide && state.status !== 'summary' && state.status !== 'error'

  return (
    <div className="stage">
      <header className="stageHeader">
        <div className="stageKicker">情境 {scenario.order} / 3</div>
        <h2 className="stageTitle">{scenario.title}</h2>
        <div className="stageTopic">{scenario.question}</div>
      </header>

      <LineOrbs orbs={orbs} speakStateRef={speakStateRef} height={400} />

      {/* 字幕區 */}
      <div className="captionArea">
        {state.status === 'connecting' && <p className="captionHint">正在喚醒兩個你的聲音…</p>}
        {state.status === 'ready' && !lastEntry && <p className="captionHint">兩個你正在整理思緒…</p>}
        {lastEntry && state.status !== 'summary' && !showChoicePanel && !waitingVerdict && (
          <p className={`caption ${lastEntry.kind === 'user' ? 'captionUser' : ''}`}>
            <span className="captionSpeaker">
              {lastEntry.kind === 'user' ? '你' : speakerName(lastEntry.agentId)}
            </span>
            {lastEntry.text}
          </p>
        )}
        {state.status === 'summary' && (
          <p className="caption captionClosing">{state.summaryText || '這一段對話，已經記進你的報告。'}</p>
        )}
      </div>

      {/* 控制列：介入 +（高透明、hover 顯形的）提前選擇 */}
      {(state.status === 'ready' || state.status === 'connecting') &&
        !state.isFinished &&
        !skipToChoice && (
          <div className="controlBar">
            <button
              type="button"
              className="btn btnIntervene"
              disabled={interventionsLeft <= 0 || state.status !== 'ready'}
              onClick={pauseDebate}
            >
              介入討論（剩 {interventionsLeft} 次）
            </button>
            <button
              type="button"
              className="btn btnSkip"
              disabled={state.status !== 'ready'}
              onClick={skipDiscussion}
            >
              跳過討論，直接選擇
            </button>
          </div>
        )}

      {/* 介入面板（paused，且不是提前選擇觸發的暫停） */}
      {state.status === 'paused' && !skipToChoice && (
        <div className="intervenePanel">
          <div className="intervenePanelTitle">兩個你安靜下來，等你說話——</div>
          {sttPending ? (
            <div className="captionHint">正在聽懂你說的話…</div>
          ) : (
            <>
              <button
                type="button"
                className={`btn btnHold ${isHolding ? 'btnHoldActive' : ''}`}
                onPointerDown={beginHold}
                onPointerUp={endHold}
                onPointerLeave={() => isHolding && endHold()}
              >
                {isHolding ? '正在聽…放開送出' : '按住說話'}
              </button>
              {micError && <div className="errorNote">{micError}</div>}
              <div className="interveneTextRow">
                <input
                  type="text"
                  value={interveneText}
                  placeholder="或直接輸入你的想法…"
                  onChange={(e) => setInterveneText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitText()}
                />
                <button type="button" className="btn" onClick={submitText} disabled={!interveneText.trim()}>
                  送出
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 對話達上限（或提前跳過）→ 做出選擇 */}
      {showChoicePanel && (
        <div className="choicePanel">
          <div className="choicePanelTitle">
            {skipToChoice && !state.isFinished
              ? `你已經有答案了——${scenario.question}`
              : `聽完兩個你的聲音——${scenario.question}`}
          </div>
          <div className="choiceButtons">
            {['a', 'b'].map((side) => {
              const c = scenario.choices[side]
              return (
                <button
                  key={side}
                  type="button"
                  className="btn btnChoice"
                  style={{ '--choice-hue': c.hue }}
                  onClick={() => handleChoose(side)}
                >
                  <span className="choiceStance">{c.stanceName}</span>
                  <span className="choiceLabel">{c.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 選完等待判決書生成 */}
      {waitingVerdict && <p className="captionHint">正在為這個情境寫下紀錄…</p>}

      {state.status === 'error' && (
        <div className="errorNote">連線發生問題：{state.lastError}（請重新整理或呼叫工作人員）</div>
      )}
    </div>
  )
}
