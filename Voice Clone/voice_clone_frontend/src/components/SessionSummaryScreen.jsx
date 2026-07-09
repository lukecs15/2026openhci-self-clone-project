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
 *   - 過渡：只需要平滑過渡（WaveformAvatar 本身的 lerpSignatureTowards
 *     已經會把「融合後的基準簽章」平滑帶到「疊加總結情緒後的目標簽章」，
 *     不需要額外寫「各 agent 波形飛向中心再融合」的匯聚動畫——那個效果是
 *     之後可以再做的加強，目前刻意先不做）。
 *
 * 目前只在網頁端呈現最終結果；把總結句子與波形傳送到使用者手機的功能是
 * 之後的目標，這裡先不處理。
 *
 * ── 進場轉場（修過的真實回報問題：畫面直接硬切到結束畫面）─────────────
 * 第一版是 VoiceAgentsPage.jsx 的條件渲染直接切換（上一秒還是對話畫面，
 * 下一秒整個結束畫面連同文字/按鈕一次全部出現），使用者實測回報這樣的
 * 切換太生硬，希望有柔和的轉場、文字用淡入呈現。修法：掛載後用
 * `visible` 這個 state（透過 `requestAnimationFrame` 延後一幀才設成
 * true，確保瀏覽器先把 opacity:0 的初始樣式畫出來一次，`visible` 變
 * true 時的樣式變化才會真的觸發 CSS transition，而不是「初始值跟目標值
 * 同一幀套用」導致沒有轉場效果直接跳過去）分階段淡入：整個畫面先柔和
 * 淡入（背景／波形），文字跟離開按鈕再依序延遲淡入＋些微上移，讓畫面
 * 有「先靜下來、才浮現文字」的層次感，而不是所有內容一次砸出來。
 */

import { useEffect, useMemo, useState } from 'react'
import WaveformAvatar from './WaveformAvatar'
import { getWaveformSignature, mergeWaveformSignatures } from '../utils/waveformSignature'

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

  // 見檔案開頭「進場轉場」說明：掛載當下先維持 false（對應 opacity:0 的
  // 初始樣式），下一幀才切成 true，讓瀏覽器有機會先畫出初始狀態一次，
  // 之後的樣式變化才會真的觸發 CSS transition。
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

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
            opacity: visible ? 1 : 0,
            transform: visible ? 'translateY(0)' : 'translateY(16px)',
            transition: 'opacity 1100ms ease 500ms, transform 1100ms ease 500ms',
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
            opacity: visible ? 1 : 0,
            transform: visible ? 'translateY(0)' : 'translateY(16px)',
            transition: 'opacity 900ms ease 900ms, transform 900ms ease 900ms',
          }}
        >
          {leaveLabel}
        </button>
      </div>
    </div>
  )
}
