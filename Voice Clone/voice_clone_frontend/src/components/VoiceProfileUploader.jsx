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
import { cloneVoiceFromRecording } from '../api/voiceAgentClient'
import { ASSIGN_TARGET_ALL } from '../store/voiceProfileAssignment'

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
          <span style={{ fontSize: '0.8rem', color: '#a5b4fc' }}>
            已建立：{profile.label}（逐字稿：{profile.reference_text || '（無，可能自動轉錄失敗）'}）
          </span>
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
