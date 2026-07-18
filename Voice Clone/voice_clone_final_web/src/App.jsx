/**
 * App.jsx — 體驗總導演（final web 的 step 狀態機）
 *
 * connect（QR 連結，等手機上傳）
 *   → 對每個情境：intro（圖片+文字導入）→ debate（立場辯論+介入+選擇）
 *   → report（三情境聚合報告 + take away QR）
 *
 * session_id：網址帶 ?session=<id> 可指定（除錯/接續用），否則每次載入
 * 生成新的 uuid——QR 內容、辯論 WS、結果回寫全部共用這一個 id（與
 * 後端 onboarding 流程的設計一致：主系統一場體驗一個 id）。
 */

import { useEffect, useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import ConnectGate from './components/ConnectGate'
import ScenarioIntro from './components/ScenarioIntro'
import DebateStage from './components/DebateStage'
import ReportView from './components/ReportView'
import { SCENARIOS } from './data/scenarios'
import { preloadScenarioImages } from './utils/preloadAssets'

function resolveSessionId() {
  if (typeof window === 'undefined') return uuidv4()
  const fromUrl = new URLSearchParams(window.location.search).get('session')
  return fromUrl || uuidv4()
}

export default function App() {
  const sessionId = useMemo(resolveSessionId, [])
  const [phase, setPhase] = useState('connect') // 'connect' | 'intro' | 'debate' | 'report'
  const [session, setSession] = useState(null) // 後端 OnboardingSession
  const [scenarioIndex, setScenarioIndex] = useState(0)
  const [records, setRecords] = useState([])

  const scenario = SCENARIOS[scenarioIndex] || null

  // 掛載即預載三個情境的圖片（使用者掃 QR/填問卷的空檔就下載完），
  // 進入情境頁時直接命中快取，不會有「圖片慢半拍浮出來」的等待感。
  useEffect(() => {
    preloadScenarioImages(SCENARIOS)
  }, [])

  const handleLinked = (linkedSession) => {
    setSession(linkedSession)
    setPhase('intro')
  }

  const handleScenarioComplete = (record) => {
    const nextRecords = [...records, record]
    setRecords(nextRecords)
    if (scenarioIndex + 1 < SCENARIOS.length) {
      setScenarioIndex(scenarioIndex + 1)
      setPhase('intro')
    } else {
      setPhase('report')
    }
  }

  const handleRestart = () => {
    // 換下一位體驗者：整頁重載 + 全新 session id（避免任何殘留狀態）
    window.location.href = window.location.pathname
  }

  return (
    <div className="appRoot">
      {phase === 'connect' && <ConnectGate sessionId={sessionId} onLinked={handleLinked} />}
      {phase === 'intro' && scenario && (
        <ScenarioIntro scenario={scenario} onEnter={() => setPhase('debate')} />
      )}
      {phase === 'debate' && scenario && (
        <DebateStage
          sessionId={sessionId}
          session={session}
          scenario={scenario}
          onComplete={handleScenarioComplete}
        />
      )}
      {phase === 'report' && (
        <ReportView sessionId={sessionId} session={session} records={records} onRestart={handleRestart} />
      )}
    </div>
  )
}
