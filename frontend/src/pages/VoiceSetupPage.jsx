/**
 * VoiceSetupPage.jsx — 聲音克隆設定頁面（路由：/voice-setup）
 *
 * 設計重點：
 * - 一個共用錄音樣本，套用至所有物件
 * - 支援直接麥克風錄音（MediaRecorder）或上傳 WAV 檔
 * - 各物件只需調整音高/語速/音量，共用同一樣本克隆
 * - 上傳一次，後端同時為所有物件建立 VoiceProfile
 */

import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import useAppStore from '../store/useAppStore'

/**
 * 將任意音訊 Blob（webm/opus 等）轉換為 16-bit PCM WAV Blob。
 * 使用瀏覽器原生 AudioContext 解碼，再手動編碼為 WAV 格式。
 * XTTS v2 的 reference audio 需要合法的 WAV 格式，MediaRecorder
 * 在大多數瀏覽器輸出的是 webm/opus，故必須在上傳前轉換。
 */
async function convertBlobToWav(audioBlob, targetSampleRate = 22050) {
  const arrayBuffer = await audioBlob.arrayBuffer()
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: targetSampleRate,
  })
  let audioBuffer
  try {
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
  } finally {
    await audioContext.close()
  }

  // 合併多聲道為 mono
  const sampleRate = audioBuffer.sampleRate
  const length = audioBuffer.length
  let samples
  if (audioBuffer.numberOfChannels > 1) {
    const ch0 = audioBuffer.getChannelData(0)
    const ch1 = audioBuffer.getChannelData(1)
    samples = new Float32Array(length)
    for (let i = 0; i < length; i++) samples[i] = (ch0[i] + ch1[i]) / 2
  } else {
    samples = audioBuffer.getChannelData(0)
  }

  // 編碼為 WAV（RIFF header + 16-bit PCM）
  const wavBuffer = new ArrayBuffer(44 + length * 2)
  const v = new DataView(wavBuffer)
  const w = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + length * 2, true)
  w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)                           // PCM
  v.setUint16(22, 1, true)                           // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)              // byte rate
  v.setUint16(32, 2, true)                           // block align
  v.setUint16(34, 16, true)                          // bits per sample
  w(36, 'data'); v.setUint32(40, length * 2, true)
  let off = 44
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    off += 2
  }
  return new Blob([wavBuffer], { type: 'audio/wav' })
}

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api'

/** 各物件預設音高差異（讓聲音有所區分） */
const DEFAULT_OFFSETS = [
  { pitch_shift:  0.0, speed: 1.00, energy: 1.0 },   // 物件 1：原聲
  { pitch_shift:  1.5, speed: 0.95, energy: 0.90 },   // 物件 2：稍高音
  { pitch_shift: -1.5, speed: 1.05, energy: 1.10 },   // 物件 3：稍低音
  { pitch_shift:  2.5, speed: 0.90, energy: 0.85 },   // 物件 4：高音輕柔
]

// ─────────────────────────────────────────────────────────────────────────────
// 共用錄音元件
// ─────────────────────────────────────────────────────────────────────────────

function VoiceRecorder({ onSampleReady }) {
  const [isRecording, setIsRecording] = useState(false)
  const [blob, setBlob] = useState(null)
  const [audioUrl, setAudioUrl] = useState(null)
  const [recSeconds, setRecSeconds] = useState(0)
  const [liveSeconds, setLiveSeconds] = useState(0)
  const [error, setError] = useState('')

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const startRef = useRef(null)

  const startRecording = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      chunksRef.current = []

      const mimeType = MediaRecorder.isTypeSupported('audio/wav')
        ? 'audio/wav'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        clearInterval(timerRef.current)
        const dur = Math.round((Date.now() - startRef.current) / 1000)
        setRecSeconds(dur)

        const rawBlob = new Blob(chunksRef.current, { type: mimeType })

        // 若瀏覽器錄製的不是 WAV（通常是 webm/opus），
        // 先轉為 PCM WAV，確保 XTTS v2 能正確讀取 reference audio
        let finalBlob = rawBlob
        if (!mimeType.includes('wav')) {
          try {
            finalBlob = await convertBlobToWav(rawBlob)
            console.log('[VoiceRecorder] 錄音轉換完成 → WAV', finalBlob.size, 'bytes')
          } catch (err) {
            console.warn('[VoiceRecorder] WAV 轉換失敗，使用原始格式', err)
          }
        }

        const url = URL.createObjectURL(finalBlob)
        setBlob(finalBlob)
        setAudioUrl(url)
        onSampleReady(finalBlob)
      }

      recorder.start(100)
      startRef.current = Date.now()
      setIsRecording(true)
      setLiveSeconds(0)
      timerRef.current = setInterval(() => {
        setLiveSeconds(Math.round((Date.now() - startRef.current) / 1000))
      }, 500)
    } catch (err) {
      setError('無法存取麥克風：' + err.message)
    }
  }

  const stopRecording = () => {
    mediaRecorderRef.current?.state === 'recording' && mediaRecorderRef.current.stop()
    clearInterval(timerRef.current)
    setIsRecording(false)
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setError('')

    // 無論上傳什麼格式（WAV/WebM/MP4 等）都走同一套轉換流程：
    // AudioContext.decodeAudioData → 16-bit PCM WAV
    // 這確保 XTTS v2 的 torchaudio.load() 能正確讀取，
    // 同時也避免某些非標準 WAV（24-bit、float32 等）造成 soundfile 錯誤。
    let finalBlob = file
    try {
      finalBlob = await convertBlobToWav(file)
      console.log('[VoiceRecorder] 檔案轉換完成 → WAV', finalBlob.size, 'bytes')
    } catch (err) {
      console.error('[VoiceRecorder] WAV 轉換失敗，將使用原始格式（可能導致 XTTS 錯誤）:', err)
      setError(`音訊轉換失敗：${err.message}。請嘗試其他格式的檔案。`)
    }

    if (audioUrl) URL.revokeObjectURL(audioUrl)
    const url = URL.createObjectURL(finalBlob)
    setBlob(finalBlob)
    setAudioUrl(url)
    setRecSeconds(0)
    onSampleReady(finalBlob)
  }

  return (
    <>
      <style>{`
        @keyframes recPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
          50% { box-shadow: 0 0 0 10px rgba(239,68,68,0); }
        }
      `}</style>

      {/* 錄音按鈕 + 狀態 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <button
          onClick={isRecording ? stopRecording : startRecording}
          style={{
            width: '62px', height: '62px', borderRadius: '50%', flexShrink: 0,
            background: isRecording ? '#ef4444' : 'rgba(99,102,241,0.85)',
            border: isRecording ? '2px solid #fca5a5' : '2px solid rgba(99,102,241,0.4)',
            color: '#fff', fontSize: '1.4rem', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: isRecording ? 'recPulse 1s ease-in-out infinite' : 'none',
            transition: 'background 0.2s',
          }}
          title={isRecording ? '停止錄音' : '開始錄音'}
        >
          {isRecording ? '⏹' : '🎙'}
        </button>

        <div>
          {isRecording ? (
            <div style={{ color: '#fca5a5', fontWeight: 600 }}>錄音中… {liveSeconds}s（再按停止）</div>
          ) : blob ? (
            <div style={{ color: '#86efac', fontWeight: 600 }}>
              ✓ 已取得樣本{recSeconds > 0 ? `（${recSeconds} 秒）` : '（已上傳檔案）'}
            </div>
          ) : (
            <div style={{ color: '#94a3b8' }}>按下麥克風開始錄音<br />
              <span style={{ fontSize: '0.78rem' }}>建議 15–30 秒，說話清晰</span>
            </div>
          )}
        </div>
      </div>

      {/* 播放預覽 */}
      {audioUrl && !isRecording && (
        <audio
          src={audioUrl}
          controls
          style={{ width: '100%', marginBottom: '0.8rem', borderRadius: '6px' }}
        />
      )}

      {/* 重新錄音 */}
      {blob && !isRecording && (
        <button
          onClick={() => {
            setBlob(null); setAudioUrl(null); setRecSeconds(0); onSampleReady(null)
          }}
          style={{
            background: 'none', border: 'none', color: '#64748b',
            fontSize: '0.8rem', cursor: 'pointer', padding: '0 0 0.75rem',
          }}
        >
          ↺ 重新錄音
        </button>
      )}

      {/* 或者上傳檔案 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#475569', fontSize: '0.8rem' }}>
        <div style={{ flex: 1, height: '1px', background: 'rgba(71,85,105,0.4)' }} />
        或者
        <div style={{ flex: 1, height: '1px', background: 'rgba(71,85,105,0.4)' }} />
      </div>

      <label style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        marginTop: '0.6rem',
        padding: '0.45rem 1rem',
        background: 'rgba(30,41,59,0.9)',
        border: '1px solid rgba(99,102,241,0.3)',
        borderRadius: '8px', color: '#94a3b8', fontSize: '0.83rem', cursor: 'pointer',
      }}>
        📁 選擇 WAV / WebM 檔案
        <input type="file" accept=".wav,.webm,audio/*" style={{ display: 'none' }} onChange={handleFileUpload} />
      </label>

      {error && (
        <div style={{ color: '#fca5a5', fontSize: '0.8rem', marginTop: '0.5rem' }}>⚠ {error}</div>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 各物件音高調整卡（不含上傳，共用樣本）
// ─────────────────────────────────────────────────────────────────────────────

function SliderRow({ label, value, onSet, min, max, step, unit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginBottom: '0.35rem' }}>
      <span style={{ width: '68px', color: '#94a3b8', fontSize: '0.77rem', flexShrink: 0 }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onSet(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: '#6366f1' }}
      />
      <span style={{ width: '46px', textAlign: 'right', color: '#c4b5fd', fontSize: '0.8rem' }}>
        {value > 0 && unit !== 'x' ? '+' : ''}{value.toFixed(2)}{unit}
      </span>
    </div>
  )
}

function ObjectTuneCard({ object, index, values, onChange }) {
  return (
    <div style={{
      background: 'rgba(30,41,59,0.6)',
      border: '1px solid rgba(99,102,241,0.22)',
      borderRadius: '10px', padding: '0.9rem 1rem', marginBottom: '0.6rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', marginBottom: '0.65rem' }}>
        <div style={{
          width: '26px', height: '26px', borderRadius: '50%',
          background: 'rgba(99,102,241,0.2)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#a78bfa', fontSize: '0.8rem', fontWeight: 700,
        }}>
          {index + 1}
        </div>
        <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.95rem' }}>
          {object.object_name}
        </span>
      </div>

      <SliderRow label="音高偏移" value={values.pitch_shift}
        onSet={v => onChange('pitch_shift', v)} min={-3} max={3} step={0.5} unit=" st" />
      <SliderRow label="語速" value={values.speed}
        onSet={v => onChange('speed', v)} min={0.8} max={1.2} step={0.05} unit="x" />
      <SliderRow label="音量" value={values.energy}
        onSet={v => onChange('energy', v)} min={0.5} max={1.5} step={0.1} unit="x" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 主頁面
// ─────────────────────────────────────────────────────────────────────────────

export default function VoiceSetupPage() {
  const navigate = useNavigate()
  const objects = useAppStore(s => s.voiceSession.objects)

  const [sharedSample, setSharedSample] = useState(null)
  const [objParams, setObjParams] = useState(
    () => objects.map((_, i) => ({ ...DEFAULT_OFFSETS[i % 4] }))
  )
  const [applyStatus, setApplyStatus] = useState('idle')  // idle | uploading | done | error
  const [errorMsg, setErrorMsg] = useState('')
  const [progress, setProgress] = useState('')

  const handleObjParamChange = useCallback((index, key, value) => {
    setObjParams(prev => {
      const next = [...prev]
      next[index] = { ...next[index], [key]: value }
      return next
    })
  }, [])

  const handleApplyAll = async () => {
    if (!sharedSample) {
      setErrorMsg('請先錄音或上傳語音樣本')
      return
    }
    setApplyStatus('uploading')
    setErrorMsg('')
    setProgress('上傳樣本中…')

    try {
      // Step 1: 只上傳一次共用樣本
      // 錄音 Blob 已在前端轉換為 WAV；使用者直接上傳的檔案保留原名
      const sampleFilename = sharedSample.name || 'voice_sample.wav'
      const formData = new FormData()
      formData.append('file', sharedSample, sampleFilename)
      formData.append('object_id', 'shared')
      const uploadRes = await axios.post(`${API}/voice/upload-sample`, formData)
      const { filename } = uploadRes.data

      setProgress(`建立聲音 Profile（共 ${objects.length} 個物件）…`)

      // Step 2: 為每個物件建立 VoiceProfile（同一 temp 檔，不同參數）
      // 注意：clone 端點不會自動刪除 temp 檔，確保所有物件都能讀到同一份樣本
      await Promise.all(
        objects.map((obj, i) =>
          axios.post(`${API}/voice/clone`, {
            object_id: obj.object_id,
            object_name: obj.object_name,
            pitch_shift: objParams[i].pitch_shift,
            speed: objParams[i].speed,
            energy: objParams[i].energy,
            sample_filename: filename,
          })
        )
      )

      // Step 3: 全部成功後才清理 temp 檔
      if (filename.startsWith('tmp_')) {
        axios.delete(`${API}/voice/samples/${filename}`).catch(() => {})
      }

      setApplyStatus('done')
      setProgress('')
      setTimeout(() => navigate('/scene'), 1000)
    } catch (err) {
      setErrorMsg(err.response?.data?.detail || '上傳失敗，請再試一次')
      setApplyStatus('error')
      setProgress('')
    }
  }

  // ── 無物件狀態 ──────────────────────────────────────────────────────────
  if (objects.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem', color: '#64748b' }}>
        <p>尚未設定物件。請先在 3D 模型頁面完成人格設定。</p>
        <button onClick={() => navigate('/model')} style={{
          marginTop: '1rem', padding: '0.6rem 1.5rem',
          background: '#6366f1', border: 'none', borderRadius: '8px',
          color: '#fff', cursor: 'pointer',
        }}>
          前往 3D 模型頁
        </button>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: '560px', margin: '0 auto', paddingBottom: '3rem' }}>

      {/* 標題 */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ color: '#e2e8f0', fontSize: '1.5rem', marginBottom: '0.4rem' }}>
          ✦ 聲音設定
        </h1>
        <p style={{ color: '#64748b', fontSize: '0.88rem', lineHeight: 1.65 }}>
          錄製一段聲音樣本，所有物件共用這個樣本進行克隆，
          再以不同音高讓各物件聽起來不同。
        </p>
      </div>

      {/* 建議朗讀文字 */}
      <div style={{
        background: 'rgba(99,102,241,0.07)',
        border: '1px solid rgba(99,102,241,0.2)',
        borderRadius: '10px', padding: '0.9rem 1rem', marginBottom: '1.25rem',
        fontSize: '0.83rem', color: '#94a3b8', lineHeight: 1.75,
      }}>
        <strong style={{ color: '#c4b5fd', display: 'block', marginBottom: '0.3rem' }}>
          建議朗讀以下句子（約 15-20 秒）：
        </strong>
        「今天天氣很好，我想起了那段平靜的時光。每一件物品都是記憶的載體，
        輕聲訴說著那些被遺忘的故事。我把這些記憶珍藏在心裡，等待著某天再次相遇。」
      </div>

      {/* 共用錄音區 */}
      <div style={{
        background: 'rgba(30,41,59,0.85)',
        border: '1px solid rgba(99,102,241,0.35)',
        borderRadius: '12px', padding: '1.25rem', marginBottom: '1.5rem',
      }}>
        <div style={{
          color: '#e2e8f0', fontWeight: 600, fontSize: '0.95rem', marginBottom: '1rem',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          🎙 錄製聲音樣本
          <span style={{ color: '#475569', fontSize: '0.78rem', fontWeight: 400 }}>
            （所有 {objects.length} 個物件共用）
          </span>
        </div>
        <VoiceRecorder onSampleReady={setSharedSample} />
      </div>

      {/* 各物件調整 */}
      {objects.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{
            color: '#64748b', fontSize: '0.83rem', marginBottom: '0.75rem',
          }}>
            各物件聲音微調（共用同一樣本，以音高區分）
          </div>
          {objects.map((obj, i) => (
            <ObjectTuneCard
              key={obj.object_id}
              object={obj}
              index={i}
              values={objParams[i]}
              onChange={(key, val) => handleObjParamChange(i, key, val)}
            />
          ))}
        </div>
      )}

      {/* 錯誤訊息 */}
      {errorMsg && (
        <div style={{
          color: '#fca5a5', fontSize: '0.85rem',
          marginBottom: '0.75rem', padding: '0.5rem 0.75rem',
          background: 'rgba(239,68,68,0.1)', borderRadius: '8px',
        }}>
          ⚠ {errorMsg}
        </div>
      )}

      {/* 進度訊息 */}
      {progress && (
        <div style={{ color: '#a78bfa', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          ⏳ {progress}
        </div>
      )}

      {/* 操作按鈕 */}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          onClick={() => navigate('/scene')}
          style={{
            padding: '0.7rem 1.1rem', background: 'transparent',
            border: '1px solid rgba(99,102,241,0.3)', borderRadius: '10px',
            color: '#6366f1', cursor: 'pointer', fontSize: '0.9rem',
            flexShrink: 0,
          }}
        >
          跳過
        </button>

        <button
          onClick={handleApplyAll}
          disabled={applyStatus === 'uploading' || applyStatus === 'done' || !sharedSample}
          style={{
            flex: 1, padding: '0.7rem',
            background: applyStatus === 'done'
              ? 'rgba(34,197,94,0.25)'
              : !sharedSample
              ? 'rgba(99,102,241,0.3)'
              : applyStatus === 'uploading'
              ? 'rgba(99,102,241,0.55)'
              : 'rgba(99,102,241,0.9)',
            border: 'none', borderRadius: '10px', color: '#fff',
            cursor: (applyStatus === 'uploading' || applyStatus === 'done' || !sharedSample)
              ? 'not-allowed' : 'pointer',
            fontSize: '0.93rem', fontWeight: 600, transition: 'background 0.2s',
          }}
        >
          {applyStatus === 'done'
            ? '✓ 設定完成，進入場景中…'
            : applyStatus === 'uploading'
            ? '克隆中…'
            : !sharedSample
            ? '請先錄音'
            : `套用至全部物件並進入場景 →`
          }
        </button>
      </div>
    </div>
  )
}
