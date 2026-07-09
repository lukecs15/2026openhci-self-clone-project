/**
 * SessionSummaryScreen.jsx — 對話／辯論結束後的全螢幕沉浸式結束畫面
 *
 * 需求：多 Agent 對話模式和辯論模式，使用者按下結束後，把對話紀錄（辯論
 * 模式含辯論主題）丟給 LLM 生成一句總結性的鼓勵語（見後端
 * agents/orchestrator.py / agents/debate.py 的 generate_summary()，透過
 * WebSocket 的 session_summary 事件送到前端），同時把所有參與過對話的
 * agent 波形「融合」成一個最終波形，作為使用者結束體驗後可以帶走的紀念品。
 *
 * 確認的設計方案：
 *   - 呈現方式：全螢幕沉浸式結束畫面（蓋住整個對話 UI，只有按下離開按鈕
 *     才會回到起始畫面，符合整個 app 一貫的沉浸式體驗方向）。
 *   - 融合方式：平均所有參與 agent 的波形簽章（見
 *     utils/waveformSignature.js 的 mergeWaveformSignatures()）算出一個
 *     共同基準，再直接把總結句子丟進既有的 WaveformAvatar——沿用它內部
 *     `applyEmotionSignal(signature, analyzeTurnEmotion(currentText))` 的
 *     邏輯，不需要另外寫一套情緒疊加邏輯：把 mergeWaveformSignatures() 的
 *     結果當 signature prop、summaryText 當 currentText prop 傳進去即可，
 *     WaveformAvatar 自己會把總結句子的情緒訊號疊加上去、平滑過渡呈現。
 *   - 過渡：進場先播放「各 agent 波形飛向中心再融合」的匯聚動畫（見
 *     components/AgentMergeConverge.jsx），播完才淡入總結文字；融合波形
 *     本身接著仍然用 WaveformAvatar 內建的 lerpSignatureTowards 平滑地
 *     從「融合後的基準簽章」過渡到「疊加總結情緒後的目標簽章」，兩層
 *     過渡各司其職：匯聚動畫負責「視覺敘事」（各自的波紋收斂成一個），
 *     lerpSignatureTowards 負責「融合後那個波形本身的情緒表現」。
 *
 * 目前只在網頁端呈現最終結果；把總結句子與波形傳送到使用者手機的功能是
 * 之後的目標，這裡先不處理。
 *
 * ── 進場轉場時間軸（修過的真實回報問題：畫面直接硬切到結束畫面）───────
 * 第一版是 VoiceAgentsPage.jsx 的條件渲染直接切換（上一秒還是對話畫面，
 * 下一秒整個結束畫面連同文字/按鈕一次全部出現），使用者實測回報這樣的
 * 切換太生硬，希望有柔和的轉場、文字用淡入呈現，後續又進一步要求要有
 * 「Agent 波形融合」的視覺化動畫。現在完整的進場時間軸分三階段：
 *   1. 掛載後用 `visible` 這個 state（透過 `requestAnimationFrame` 延後
 *      一幀才設成 true，確保瀏覽器先把 opacity:0 的初始樣式畫出來一次，
 *      `visible` 變 true 時的樣式變化才會真的觸發 CSS transition）讓
 *      整個畫面（背景＋融合波形）柔和淡入。
 *   2. 淡入的同時，`mergePhase === 'converging'` 讓 `AgentMergeConverge`
 *      在畫面上疊一層「各 agent 化成發光能量球＋自己的波形線條，環狀
 *      排列後一起旋轉內縮、融進中心」的動畫（含拖尾殘影與收斂瞬間的
 *      光暈綻放，細節見該檔案），播完（`onComplete`）才把 `mergePhase`
 *      切成 `'done'`。
 *   3. `mergePhase === 'done'` 之後，總結文字跟離開按鈕才依序延遲淡入＋
 *      些微上移。三個階段刻意不重疊，讓「畫面靜下來」「波形融合」「文字
 *      浮現」是三個依序發生、各自有意義的動作，而不是所有內容一次砸出來。
 *
 * 尊重 `prefers-reduced-motion`：使用者系統設定開啟「減少動態效果」時，
 * 直接跳過匯聚動畫（`mergePhase` 初始值就是 `'done'`），總結文字改成
 * 緊接在畫面淡入之後就出現，不會為了動畫而讓行動不便的使用者不舒服。
 */

import { useEffect, useMemo, useState } from 'react'
import WaveformAvatar from './WaveformAvatar'
import AgentMergeConverge from './AgentMergeConverge'
import { getWaveformSignature, mergeWaveformSignatures } from '../utils/waveformSignature'

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function SessionSummaryScreen({ agents, summaryText, onLeave, leaveLabel = '返回起始畫面' }) {
  // 只依賴 agent_id 組成的 key，避免 agents 陣列每次 render 都是新的物件
  // 參考（例如父層每次 render 都重新 filter/map 出一份新陣列）卻沒有實際
  // 內容變化時，白白重算一次融合簽章。
  const agentsKey = (agents || []).map((a) => a.agent_id || a.display_name).join('|')

  const mergedSignature = useMemo(() => {
    const signatures = (agents || []).map((agent) => getWaveformSignature(agent))
    return mergeWaveformSignatures(signatures)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsKey])

  // 見檔案開頭「進場轉場時間軸」說明：掛載當下先維持 false（對應
  // opacity:0 的初始樣式），下一幀才切成 true，讓瀏覽器有機會先畫出初始
  // 狀態一次，之後的樣式變化才會真的觸發 CSS transition。
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // 'converging'：AgentMergeConverge 正在播放匯聚動畫，文字/按鈕保持隱藏。
  // 'done'：匯聚動畫播完（或使用者要求減少動態效果、或沒有任何 agent 可以
  // 匯聚），可以開始淡入文字/按鈕了。只在掛載當下決定初始值一次——agents
  // 在結束畫面顯示期間本來就不會變動，不需要每次 render 重新判斷。
  const [mergePhase, setMergePhase] = useState(() =>
    prefersReducedMotion() || (agents || []).length === 0 ? 'done' : 'converging',
  )
  const showContent = mergePhase === 'done'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#020617',
        display: 'flex',
        flexDirection: 'column',
        opacity: visible ? 1 : 0,
        transition: 'opacity 900ms ease',
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <WaveformAvatar signature={mergedSignature} isSpeaking currentText={summaryText} />
      </div>

      {mergePhase === 'converging' && (
        <AgentMergeConverge agents={agents} onComplete={() => setMergePhase('done')} />
      )}

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
          gap: '2rem',
        }}
      >
        <p
          style={{
            maxWidth: '640px',
            fontSize: '1.4rem',
            lineHeight: 1.8,
            color: '#f8fafc',
            textShadow: '0 2px 12px rgba(0,0,0,0.6)',
            margin: 0,
            opacity: showContent ? 1 : 0,
            transform: showContent ? 'translateY(0)' : 'translateY(16px)',
            transition: 'opacity 1100ms ease 150ms, transform 1100ms ease 150ms',
          }}
        >
          {summaryText || '謝謝你今天願意敞開心分享。'}
        </p>

        <button
          onClick={onLeave}
          style={{
            padding: '0.75rem 2rem',
            borderRadius: '999px',
            border: '1px solid rgba(226,232,240,0.4)',
            background: 'rgba(15,23,42,0.6)',
            color: '#e2e8f0',
            fontSize: '0.9rem',
            cursor: 'pointer',
            backdropFilter: 'blur(4px)',
            opacity: showContent ? 1 : 0,
            transform: showContent ? 'translateY(0)' : 'translateY(16px)',
            transition: 'opacity 900ms ease 550ms, transform 900ms ease 550ms',
          }}
        >
          {leaveLabel}
        </button>
      </div>
    </div>
  )
}
