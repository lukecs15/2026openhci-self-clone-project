/**
 * useVoiceConversation.js — 語音對話 WebSocket 管理 Hook
 *
 * 負責：
 * - 連接/斷開 WebSocket（ws://localhost:8000/ws/conversation/{sessionId}）
 * - 管理麥克風錄音（MediaRecorder API，WAV 格式）
 * - 接收並分派 server 訊息（object_speaking / user_transcript / can_end 等）
 * - 播放 TTS 音訊（base64 WAV → AudioContext 播放）
 * - 回傳對話狀態給 VoiceScene.jsx
 *
 * 使用方式：
 *   const {
 *     connect, disconnect,
 *     startRecording, stopRecording,
 *     sendText,
 *     isConnected, isRecording,
 *   } = useVoiceConversation(sessionId, { onObjectSpeaking, onCanEnd, ... })
 *
 * TODO: 加入 VAD（自動偵測靜音結束錄音，不需手動放開按鈕）
 * TODO: 加入逐字 transcript 串流（目前等 STT 完全完成才顯示）
 * TODO: WebSocket reconnect 自動重連機制
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const WS_BASE = import.meta.env.VITE_WS_BASE_URL || 'ws://localhost:8000'

/**
 * @typedef {Object} VoiceConversationCallbacks
 * @property {(objectId: string, objectName: string, text: string, audioB64: string) => void} onObjectSpeaking
 * @property {(text: string) => void} onUserTranscript
 * @property {() => void} onAllListening
 * @property {() => void} onCanEnd
 * @property {(phase: string) => void} onPhaseChanged
 * @property {(mode: string) => void} onSceneModeChanged
 * @property {(summary: object) => void} onSessionReady
 * @property {(msg: string) => void} onError
 */

/**
 * @param {string} sessionId
 * @param {VoiceConversationCallbacks} callbacks
 */
export function useVoiceConversation(sessionId, callbacks = {}) {
  const wsRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const audioContextRef = useRef(null)
  const audioQueueRef = useRef([])    // 等待播放的音訊 buffer 隊列
  const isPlayingRef = useRef(false)

  const [isConnected, setIsConnected] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingMode, setRecordingMode] = useState('push')   // 'push' | 'toggle'

  // 穩定的 callback refs（避免 stale closure）
  const cbRef = useRef(callbacks)
  useEffect(() => { cbRef.current = callbacks }, [callbacks])

  // ── WebSocket 連接 ──────────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const url = `${WS_BASE}/ws/conversation/${sessionId}`
    console.log('[VoiceConversation] 連接 WS:', url)
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[VoiceConversation] WS 已連接')
      setIsConnected(true)
    }

    ws.onclose = () => {
      console.log('[VoiceConversation] WS 已斷開')
      setIsConnected(false)
    }

    ws.onerror = (err) => {
      console.error('[VoiceConversation] WS 錯誤:', err)
      cbRef.current.onError?.('WebSocket 連接失敗')
    }

    ws.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        console.warn('[VoiceConversation] 非 JSON 訊息:', event.data)
        return
      }
      _handleServerMessage(msg)
    }
  }, [sessionId])

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  // ── Server 訊息處理 ─────────────────────────────────────────────────────

  const _handleServerMessage = useCallback((msg) => {
    const type = msg.type
    console.log('[VoiceConversation] ← server:', type, msg)

    switch (type) {
      case 'session_ready':
        cbRef.current.onSessionReady?.(msg.summary)
        break

      case 'object_speaking':
        // 音訊播放由 VoiceScene.drainSpeakingQueue 直接控制（source.onended），
        // 確保文字泡泡與音訊播放精準同步，此處不再 enqueueAudio。
        cbRef.current.onObjectSpeaking?.(
          msg.object_id,
          msg.object_name,
          msg.text,
          msg.audio || ''
        )
        break

      case 'all_listening':
        // 使用者開始說話，停止目前所有播放
        if (window.speechSynthesis) window.speechSynthesis.cancel()
        audioQueueRef.current = []
        isPlayingRef.current = false
        cbRef.current.onAllListening?.()
        break

      case 'user_transcript':
        cbRef.current.onUserTranscript?.(msg.text)
        break

      case 'can_end':
        if (msg.show) cbRef.current.onCanEnd?.()
        break

      case 'phase_changed':
        cbRef.current.onPhaseChanged?.(msg.phase)
        break

      case 'scene_mode_changed':
        cbRef.current.onSceneModeChanged?.(msg.mode)
        break

      case 'session_ended':
        disconnect()
        break

      case 'ping':
        // 後端心跳，回應 pong 保持連線（F5-TTS 載入期間尤其重要）
        _sendWs({ type: 'pong' })
        break

      case 'error':
        console.error('[VoiceConversation] server error:', msg.message)
        cbRef.current.onError?.(msg.message)
        break

      default:
        console.warn('[VoiceConversation] 未知訊息類型:', type)
    }
  }, [disconnect])

  // ── 音訊播放（排隊播放，避免重疊）────────────────────────────────────────

  const _getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    return audioContextRef.current
  }, [])

  const _enqueueAudio = useCallback(async (audioB64) => {
    audioQueueRef.current.push(audioB64)
    if (!isPlayingRef.current) {
      _drainAudioQueue()
    }
  }, [])

  const _drainAudioQueue = useCallback(async () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false
      return
    }
    isPlayingRef.current = true
    const b64 = audioQueueRef.current.shift()

    try {
      const ctx = _getAudioContext()
      // 恢復被 autoplay policy 暫停的 context
      if (ctx.state === 'suspended') await ctx.resume()

      const binaryStr = atob(b64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

      const audioBuffer = await ctx.decodeAudioData(bytes.buffer)
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      source.onended = () => _drainAudioQueue()
      source.start()
    } catch (err) {
      console.error('[VoiceConversation] 音訊播放失敗:', err)
      _drainAudioQueue()   // 失敗也繼續播放下一個
    }
  }, [_getAudioContext])

  // ── 瀏覽器 TTS Fallback（無語音 Profile 時使用）────────────────────────

  const _speakFallback = useCallback((text) => {
    if (!window.speechSynthesis) return
    // 取消目前正在說的（避免累積排隊）
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-TW'
    utterance.rate = 0.9
    utterance.pitch = 1.0
    // 嘗試選用中文語音
    const voices = window.speechSynthesis.getVoices()
    const zhVoice = voices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) utterance.voice = zhVoice
    window.speechSynthesis.speak(utterance)
  }, [])

  // ── 麥克風錄音 ──────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (isRecording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      })

      audioChunksRef.current = []
      // 優先用 WAV，不支援則 fallback 到 webm
      const mimeType = MediaRecorder.isTypeSupported('audio/wav')
        ? 'audio/wav'
        : 'audio/webm;codecs=opus'

      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(audioChunksRef.current, { type: mimeType })
        const arrayBuffer = await blob.arrayBuffer()
        const b64 = _arrayBufferToBase64(arrayBuffer)
        _sendWs({ type: 'user_audio', audio: b64 })
      }

      recorder.start(100)   // 每 100ms 收集一次 chunk
      setIsRecording(true)
      console.log('[VoiceConversation] 開始錄音')
    } catch (err) {
      console.error('[VoiceConversation] 麥克風存取失敗:', err)
      cbRef.current.onError?.('無法存取麥克風：' + err.message)
    }
  }, [isRecording])

  const stopRecording = useCallback(() => {
    if (!isRecording || !mediaRecorderRef.current) return
    mediaRecorderRef.current.stop()
    setIsRecording(false)
    console.log('[VoiceConversation] 停止錄音，送出音訊')
  }, [isRecording])

  // ── 文字輸入 ────────────────────────────────────────────────────────────

  const sendText = useCallback((text) => {
    _sendWs({ type: 'user_text', text })
  }, [])

  // ── 場景初始化 ──────────────────────────────────────────────────────────

  const initSession = useCallback((objects, sceneMode = 'spatial') => {
    _sendWs({ type: 'init_session', objects, scene_mode: sceneMode })
  }, [])

  const requestIntro = useCallback((objectId) => {
    _sendWs({ type: 'request_intro', object_id: objectId })
  }, [])

  const setSceneMode = useCallback((mode) => {
    _sendWs({ type: 'scene_mode', mode })
  }, [])

  const endSession = useCallback(() => {
    _sendWs({ type: 'end_session' })
  }, [])

  // ── 內部輔助 ────────────────────────────────────────────────────────────

  const _sendWs = (payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload))
    } else {
      console.warn('[VoiceConversation] WS 未連接，無法送出:', payload.type)
    }
  }

  const _arrayBufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect()
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
      if (window.speechSynthesis) window.speechSynthesis.cancel()
    }
  }, [disconnect])

  return {
    // 連線控制
    connect,
    disconnect,
    isConnected,
    // 錄音控制
    startRecording,
    stopRecording,
    isRecording,
    recordingMode,
    setRecordingMode,
    // 文字 / 場景控制
    sendText,
    initSession,
    requestIntro,
    setSceneMode,
    endSession,
  }
}
