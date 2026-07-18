/**
 * TranscriptPanel.jsx — 隱藏式對話紀錄抽屜
 *
 * 依實測回饋改為「預設隱藏」：主舞台（雙球/字幕/介入介面）維持置中不被
 * 擠壓，畫面右緣只留一個低調的直立籤（半透明，hover 變清楚，與跳過按鈕
 * 同一套低干擾語彙）；點籤從右側滑出抽屜，再點（或按抽屜的 ×）收回。
 *
 * 內容：state.transcript（事件序列化管線逐句寫入——每句都是在「音訊真的
 * 開始播那一句」的時間點才加進來，跟語音同步、不劇透）。立場發言以該
 * 立場 hue 色條標示，使用者介入的發言另外標記。開著時新內容自動跟捲
 * （使用者往上翻閱、離底部較遠時不打擾）；抽屜收合時仍掛載（保留捲動
 * 位置，重開不跳位）。
 */

import { useEffect, useRef, useState } from 'react'

export default function TranscriptPanel({ transcript, agentMeta }) {
  const [open, setOpen] = useState(false)
  const listRef = useRef(null)

  useEffect(() => {
    const el = listRef.current
    if (!el || !open) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [transcript.length, open])

  return (
    <>
      <button
        type="button"
        className={`transcriptTab ${open ? 'transcriptTabOpen' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? '收合對話紀錄' : '展開對話紀錄'}
      >
        對話紀錄
      </button>

      <aside
        className={`transcriptDrawer ${open ? 'transcriptDrawerOpen' : ''}`}
        aria-label="對話紀錄"
        aria-hidden={!open}
      >
        <div className="transcriptHeader">
          <span className="transcriptTitle">對話紀錄</span>
          <button
            type="button"
            className="transcriptClose"
            onClick={() => setOpen(false)}
            aria-label="收合對話紀錄"
          >
            ×
          </button>
        </div>
        <div className="transcriptList" ref={listRef}>
          {transcript.length === 0 && (
            <p className="transcriptEmpty">對話開始後，兩個你說過的每句話都會記錄在這裡。</p>
          )}
          {transcript.map((entry) => {
            const meta = entry.kind === 'user' ? null : agentMeta[entry.agentId]
            return (
              <div
                key={entry.id}
                className={`transcriptEntry ${entry.kind === 'user' ? 'transcriptEntryUser' : ''}`}
                style={meta ? { '--entry-hue': meta.hue } : undefined}
              >
                <span className="transcriptSpeaker">
                  {entry.kind === 'user' ? '你（介入）' : meta?.name || ''}
                </span>
                <p className="transcriptText">{entry.text}</p>
              </div>
            )
          })}
        </div>
      </aside>
    </>
  )
}
