/**
 * DebateStage.jsx — 辯論／討論進行中的畫面
 *
 * 重用 AgentStage 顯示兩位 agent 發話狀態、TranscriptLog 顯示對話紀錄。
 *
 * 暫停／插話：status === 'paused' 時顯示插話輸入區（由 useDebateSession
 * 的 debate_paused 事件觸發，見該檔案說明——按下暫停後音訊/朗讀會立刻
 * 停止，不用等這裡的畫面更新）；其餘狀態顯示「暫停並插話」按鈕。
 * 插話輸入區有兩種呈現方式：
 *   - 瀏覽器語音辨識開關開啟且瀏覽器支援時，重用 MicControl（跟一般多
 *     Agent 對話同一顆元件）：按住說話會用 Web Speech API 辨識，辨識到
 *     最終結果就直接送出插話，也可以照樣直接打字送出。
 *   - 沒開語音辨識（或瀏覽器不支援）時，顯示純文字輸入框 + 送出按鈕。
 *
 * 瀏覽器 TTS／STT 開關（DevToggleLabel）直接比照一般多 Agent 對話頁的做法，
 * 跟後端 TTS/STT 是否 mock 完全獨立，純粹是前端測試輔助（見
 * useDebateSession.js 檔案開頭說明）。
 *
 * 半透明、不干擾的結束按鈕：固定在右下角，預設低存在感（低透明度），
 * 避免搶走辯論內容的注意力，滑鼠移過去才變明顯，點擊後結束整個 session、
 * 回到系統初始畫面（實際導頁邏輯交給父層頁面的 onEndSession）。
 */

import { useState } from 'react'
import AgentStage from './AgentStage'
import TranscriptLog from './TranscriptLog'
import MicControl from './MicControl'
import DevToggleLabel from './DevToggleLabel'

export default function DebateStage({
  agents,
  topicTitle,
  status,
  activeSpeakerIds,
  transcript,
  onPause,
  onIntervene,
  onEndSession,
  browserTtsEnabled,
  toggleBrowserTts,
  isBrowserTtsSupported,
  browserSttEnabled,
  toggleBrowserStt,
  isBrowserSttSupported,
  isRecording,
  onStartRecording,
  onStopRecording,
}) {
  const [interveneText, setInterveneText] = useState('')
  const [endHovered, setEndHovered] = useState(false)
  const isPaused = status === 'paused'
  const isFinished = status === 'finished'
  const useMicIntervene = browserSttEnabled && isBrowserSttSupported

  const handleSubmitIntervene = () => {
    const text = interveneText.trim()
    if (!text) return
    onIntervene(text)
    setInterveneText('')
  }

  return (
    <div style={{ position: 'relative', minHeight: '480px' }}>
      <div style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.8rem', color: '#64748b' }}>討論主題：</span>
        <strong style={{ fontSize: '0.95rem' }}>{topicTitle}</strong>
      </div>

      <AgentStage agents={agents} activeSpeakerIds={activeSpeakerIds} pendingAgentIds={[]} transcript={transcript} />

      <DevToggleLabel
        checked={browserTtsEnabled}
        disabled={!isBrowserTtsSupported}
        onChange={(e) => toggleBrowserTts(e.target.checked)}
        title={
          isBrowserTtsSupported
            ? '後端 TTS 若還是 mock（靜音），開啟這個開關可以用瀏覽器內建語音朗讀 agent 的文字，方便測試播放時序與節奏控制'
            : '目前瀏覽器不支援 Web Speech API'
        }
      >
        用瀏覽器語音朗讀（TTS 為 mock 時的測試用替代方案）
      </DevToggleLabel>
      <DevToggleLabel
        checked={browserSttEnabled}
        disabled={!isBrowserSttSupported}
        onChange={(e) => toggleBrowserStt(e.target.checked)}
        title={
          isBrowserSttSupported
            ? '開啟後，暫停插話時可以按住說話，用瀏覽器內建語音辨識把你說的話直接轉成插話文字送出'
            : '目前瀏覽器不支援 Web Speech API'
        }
      >
        用瀏覽器語音辨識（STT 為 mock 時的測試用替代方案）
      </DevToggleLabel>

      {isFinished && (
        <p style={{ textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
          討論已達回合上限，自動結束。可以按右下角按鈕離開，或重新開始一場新的討論。
        </p>
      )}

      {!isFinished && (
        <div style={{ display: 'flex', justifyContent: 'center', margin: '0.75rem 0' }}>
          {isPaused ? (
            useMicIntervene ? (
              <div style={{ width: '100%', maxWidth: '480px' }}>
                <MicControl
                  isRecording={isRecording}
                  onStartRecording={onStartRecording}
                  onStopRecording={onStopRecording}
                  onSendText={onIntervene}
                />
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.5rem', width: '100%', maxWidth: '480px' }}>
                <input
                  type="text"
                  value={interveneText}
                  onChange={(e) => setInterveneText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmitIntervene()}
                  placeholder="已暫停，輸入你想說的話插入討論…"
                  style={{
                    flex: 1,
                    padding: '0.6rem 0.85rem',
                    borderRadius: '0.5rem',
                    border: '1px solid #6366f1',
                    background: '#0f172a',
                    color: '#e2e8f0',
                  }}
                />
                <button
                  onClick={handleSubmitIntervene}
                  disabled={!interveneText.trim()}
                  style={{
                    padding: '0.6rem 1.1rem',
                    borderRadius: '0.5rem',
                    border: 'none',
                    background: '#6366f1',
                    color: '#fff',
                    fontWeight: 700,
                    cursor: interveneText.trim() ? 'pointer' : 'not-allowed',
                    opacity: interveneText.trim() ? 1 : 0.5,
                  }}
                >
                  送出並繼續
                </button>
              </div>
            )
          ) : (
            <button
              onClick={onPause}
              style={{
                padding: '0.6rem 1.5rem',
                borderRadius: '999px',
                border: '1px solid #334155',
                background: '#0f172a',
                color: '#e2e8f0',
                cursor: 'pointer',
              }}
            >
              暫停並插話
            </button>
          )}
        </div>
      )}

      <TranscriptLog transcript={transcript} agents={agents} />

      <button
        onClick={onEndSession}
        onMouseEnter={() => setEndHovered(true)}
        onMouseLeave={() => setEndHovered(false)}
        title="結束討論，回到初始畫面"
        style={{
          position: 'fixed',
          right: '1.25rem',
          bottom: '1.25rem',
          padding: '0.55rem 1rem',
          borderRadius: '999px',
          border: 'none',
          background: '#1e293b',
          color: '#e2e8f0',
          fontSize: '0.75rem',
          cursor: 'pointer',
          opacity: endHovered ? 0.9 : 0.35,
          transition: 'opacity 0.2s',
          boxShadow: endHovered ? '0 2px 10px rgba(0,0,0,0.35)' : 'none',
        }}
      >
        結束討論
      </button>
    </div>
  )
}
