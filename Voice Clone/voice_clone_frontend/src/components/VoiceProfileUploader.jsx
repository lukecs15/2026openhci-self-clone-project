/**
 * VoiceProfileUploader.jsx — 使用者聲音克隆上傳元件
 *
 * 讓使用者錄一段音（或選擇既有音檔），呼叫後端 /api/voice-profiles 建立聲音
 * 克隆 profile，然後選擇要套用到哪個 agent（或全部 agent）。
 *
 * 對應需求：「使用者自己丟入一段音訊，去克隆使用者的聲音做語音輸出」。
 * 實際的聲音克隆推理（CosyVoice 2 zero-shot）在後端 services/tts_service.py
 * 完成，這裡只負責錄音/上傳 UI 與套用範圍的選擇。
 */

import { useRef, useState } from 'react'
import { cloneVoiceFromRecording, updateVoiceProfile } from '../api/voiceAgentClient'
import { ASSIGN_TARGET_ALL } from '../store/voiceProfileAssignment'

/**
 * 前端版的「疑似 ASR 幻覺」偵測，邏輯對應後端
 * services/voice_profile_service.py 的 _looks_like_asr_hallucination。
 * 這裡只是提示使用者「這段逐字稿看起來怪怪的，建議手動修正」，真正擋掉
 * 幻覺文字進入克隆推理的把關仍在後端（自動轉錄當下就會擋）；這裡主要是
 * 涵蓋「沒觸發後端門檻但品質仍不夠好」的情況，讓使用者能自行判斷修正。
 */
function looksSuspicious(text) {
  const stripped = (text || '').replace(/\s/g, '')
  if (stripped.length < 6) return false
  const counts = {}
  for (const ch of stripped) counts[ch] = (counts[ch] || 0) + 1
  const maxCount = Math.max(...Object.values(counts))
  return maxCount / stripped.length > 0.4
}

/**
 * @param {Object} props
 * @param {Array} props.agents 目前的 agent 列表（用來讓使用者選擇套用對象）
 * @param {(profileId: string, target: string) => void} props.onApply 建立成功後呼叫，
 *   target 為 'all' 或某個 agent_id
 */
export default function VoiceProfileUploader({ agents, onApply }) {
  const [isRecording, setIsRecording] = useState(false)
  const [status, setStatus] = useState('idle') // idle | recording | uploading | done | error
  const [errorMessage, setErrorMessage] = useState('')
  const [profile, setProfile] = useState(null)
  const [assignTarget, setAssignTarget] = useState(ASSIGN_TARGET_ALL)
  const [editedText, setEditedText] = useState('')
  const [savingText, setSavingText] = useState(false)

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])

  const startRecording = async () => {
    setErrorMessage('')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(stream)
    chunksRef.current = []
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data)
    recorder.onstop = () => stream.getTracks().forEach((t) => t.stop())
    recorder.start()
    mediaRecorderRef.current = recorder
    setIsRecording(true)
    setStatus('recording')
  }

  const stopRecordingAndClone = async () => {
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    setIsRecording(false)
    setStatus('uploading')

    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true })
      recorder.stop()
    })

    try {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      const created = await cloneVoiceFromRecording(blob, '我的聲音')
      setProfile(created)
      setEditedText(created.reference_text || '')
      setStatus('done')
    } catch (err) {
      setErrorMessage(err.message || '建立聲音克隆 profile 失敗')
      setStatus('error')
    }
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setStatus('uploading')
    setErrorMessage('')
    try {
      const created = await cloneVoiceFromRecording(file, file.name)
      setProfile(created)
      setEditedText(created.reference_text || '')
      setStatus('done')
    } catch (err) {
      setErrorMessage(err.message || '建立聲音克隆 profile 失敗')
      setStatus('error')
    }
  }

  const handleApply = () => {
    if (!profile) return
    onApply(profile.profile_id, assignTarget)
  }

  const handleSaveText = async () => {
    if (!profile) return
    setSavingText(true)
    setErrorMessage('')
    try {
      const updated = await updateVoiceProfile(profile.profile_id, { reference_text: editedText })
      setProfile(updated)
    } catch (err) {
      setErrorMessage(err.message || '更新逐字稿失敗')
    } finally {
      setSavingText(false)
    }
  }

  return (
    <div
      style={{
        padding: '1rem',
        borderRadius: '0.75rem',
        background: '#0f172a',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}
    >
      <strong style={{ fontSize: '0.9rem' }}>克隆你的聲音</strong>
      <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>
        錄一段（或上傳）3-10 秒的清晰語音，之後對話時可以指定某個角色（或全部角色）用你的聲音回覆。
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {!isRecording ? (
          <button onClick={startRecording} disabled={status === 'uploading'} style={buttonStyle()}>
            開始錄音
          </button>
        ) : (
          <button onClick={stopRecordingAndClone} style={buttonStyle('#ef4444')}>
            停止並建立
          </button>
        )}
        <span style={{ color: '#475569', fontSize: '0.75rem' }}>或</span>
        <label style={{ ...buttonStyle('#334155'), cursor: 'pointer' }}>
          上傳音檔
          <input type="file" accept="audio/*" onChange={handleFileUpload} style={{ display: 'none' }} />
        </label>
      </div>

      {status === 'uploading' && <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>處理中…</span>}
      {status === 'error' && <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>{errorMessage}</span>}

      {profile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#a5b4fc' }}>已建立：{profile.label}</span>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
              參考音訊逐字稿（務必跟音檔實際內容一致，否則克隆出的聲音可能會不穩定或重複亂念）：
            </span>
            <textarea
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              rows={2}
              placeholder="（無，可能自動轉錄失敗或偵測到疑似錯誤的轉錄結果，請手動輸入音檔實際念的內容）"
              style={{
                background: '#020617',
                color: '#e2e8f0',
                border: `1px solid ${looksSuspicious(editedText) ? '#ef4444' : '#334155'}`,
                borderRadius: '0.4rem',
                padding: '0.4rem 0.5rem',
                fontSize: '0.75rem',
                resize: 'vertical',
              }}
            />
            {looksSuspicious(editedText) && (
              <span style={{ fontSize: '0.7rem', color: '#ef4444' }}>
                這段逐字稿看起來像是重複字元的異常結果（常見於自動辨識對過短/過安靜音訊的誤判），
                建議改成音檔實際念出的文字後再套用。
              </span>
            )}
            <div>
              <button
                onClick={handleSaveText}
                disabled={savingText || editedText === (profile.reference_text || '')}
                style={buttonStyle('#334155')}
              >
                {savingText ? '儲存中…' : '儲存逐字稿修正'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>套用到：</span>
            <select
              value={assignTarget}
              onChange={(e) => setAssignTarget(e.target.value)}
              style={{
                background: '#020617',
                color: '#e2e8f0',
                border: '1px solid #334155',
                borderRadius: '0.4rem',
                padding: '0.3rem 0.5rem',
              }}
            >
              <option value={ASSIGN_TARGET_ALL}>全部 agent</option>
              {agents.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  {agent.display_name}
                </option>
              ))}
            </select>
            <button onClick={handleApply} style={buttonStyle()}>
              套用
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function buttonStyle(bg = '#6366f1') {
  return {
    padding: '0.4rem 0.9rem',
    borderRadius: '0.5rem',
    border: 'none',
    background: bg,
    color: '#fff',
    fontSize: '0.8rem',
    cursor: 'pointer',
  }
}
