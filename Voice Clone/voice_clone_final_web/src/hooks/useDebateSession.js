/**
 * useDebateSession.js — final web 辯論 WebSocket Hook
 *
 * 改寫自 voice_clone_frontend/src/hooks/useDebateSession.js，完整保留兩個
 * 「控時／低延遲」的關鍵機制（這是網頁環境對話品質的核心，勿刪）：
 *
 * 1. 事件序列化管線（eventPipelineRef）：所有 agent_speaking_* 事件嚴格
 *    依抵達順序串接處理，chunk 的音訊「真的播完」才處理下一個事件——
 *    文字/高亮/聲音三者永遠對齊，暫停時也保證只需要停掉「當下這一個」
 *    音訊來源。dispatchEpochRef 讓暫停後管線裡還沒 dispatch 的舊事件
 *    全部作廢，畫面不會冒出殘留內容。（完整推導過程見原檔案的長註解）
 *
 * 2. turn_played 真實回報：agent_speaking_end 在管線裡被處理到的當下，
 *    代表這一輪的音訊真的播完了，此時才回報後端。後端收到才會放行
 *    下一輪（它其實早就預生成好、扣在 buffer 裡——「預生成下一輪」
 *    穿透式串流，見 backend PROJECT_ARCHITECTURE.md 2.3），所以體感是
 *    「一輪講完幾乎無縫接下一輪」，但後端永遠不會跑到比使用者聽到的
 *    進度更前面，暫停/插話打斷的一定是使用者正在聽的那位。
 *
 * final web 新增：
 *   - 播放鏈路掛 AnalyserNode，getSpeakLevel() 回傳目前播放音訊的能量
 *     （0~1），驅動 LineOrbs 的「說話」視覺（核心顫動/聲納漣漪/主波抖動）
 *   - sendInterventionAudio()：語音介入（16kHz WAV base64 →
 *     user_intervene_audio，後端 STT 轉錄後與文字介入收斂成同一條路徑）
 *   - init 帶 max_turns（每情境的回合上限）與自訂議題 topic_title
 */

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { debateSessionReducer, initialDebateState } from '../store/debateSessionReducer'
import {
  buildEndDebateSessionMessage,
  buildInitDebateSessionMessage,
  buildPauseDebateMessage,
  buildTurnPlayedMessage,
  buildUserInterveneAudioMessage,
  buildUserInterveneMessage,
} from '../api/debateMessages'
import { createSendQueue } from '../utils/sendQueue'
import { resolveWsBaseUrl } from '../utils/resolveWsBaseUrl'

// VITE_WS_BASE_URL 留空＝由頁面自己的來源推導（https 頁面自動用 wss），
// 連到同源的 /ws/...，由 vite dev server 的 proxy 轉發到後端——搭配
// cloudflared 單一 tunnel 部署（見 vite.config.js 說明）。有填則走
// resolveWsBaseUrl 的 scheme 校正（https 頁面把 ws:// 升級成 wss://）。
function deriveWsBase() {
  const fromEnv = import.meta.env.VITE_WS_BASE_URL
  if (fromEnv) return resolveWsBaseUrl(fromEnv)
  if (typeof window === 'undefined') return 'ws://localhost:8200'
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}`
}

const WS_BASE = deriveWsBase()

export function useDebateSession(sessionId) {
  const [state, dispatch] = useReducer(debateSessionReducer, initialDebateState)

  const wsRef = useRef(null)
  const sendQueueRef = useRef(createSendQueue())
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const analyserDataRef = useRef(null)
  const playSourceRef = useRef(null)
  const eventPipelineRef = useRef(Promise.resolve())
  const dispatchEpochRef = useRef(0)

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      // 播放鏈路：source → analyser → destination。analyser 供 LineOrbs
      // 讀取「正在講話的能量」，驅動說話視覺與真實語音同步。
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.5
      analyser.connect(ctx.destination)
      audioContextRef.current = ctx
      analyserRef.current = analyser
      analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount)
    }
    return audioContextRef.current
  }, [])

  /** 目前播放音訊的能量 0~1（沒在播放時趨近 0），LineOrbs 每幀輪詢。 */
  const getSpeakLevel = useCallback(() => {
    const analyser = analyserRef.current
    const data = analyserDataRef.current
    if (!analyser || !data) return 0
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    // RMS → 0~1 的可視化範圍（語音 RMS 通常落在 0~0.35 左右）
    return Math.min(1, rms * 4)
  }, [])

  /**
   * 播放單一 chunk（後端送來的是「裸」16-bit mono PCM + sample_rate，
   * 不能用 decodeAudioData，必須手動建 AudioBuffer——修過的真實問題，
   * 詳見 voice_clone_frontend 原檔案說明）。回傳「真的播完」才 resolve。
   */
  const playAudioChunk = useCallback(
    (base64Audio, sampleRate = 24000) => {
      if (!base64Audio) return Promise.resolve()
      const ctx = getAudioContext()
      if (ctx.state === 'suspended') ctx.resume()
      const binary = atob(base64Audio)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

      const sampleCount = Math.floor(bytes.length / 2)
      if (sampleCount === 0) return Promise.resolve()

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const floatData = new Float32Array(sampleCount)
      for (let i = 0; i < sampleCount; i += 1) {
        floatData[i] = view.getInt16(i * 2, true) / 32768
      }

      return new Promise((resolve) => {
        const buffer = ctx.createBuffer(1, sampleCount, sampleRate)
        buffer.copyToChannel(floatData, 0)
        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.connect(analyserRef.current)
        source.onended = () => {
          if (playSourceRef.current === source) playSourceRef.current = null
          resolve()
        }
        playSourceRef.current = source
        source.start()
      })
    },
    [getAudioContext],
  )

  /** 暫停/結束時：立刻靜音 + 讓管線裡的舊事件全部作廢。 */
  const stopAllPlaybackImmediately = useCallback(() => {
    dispatchEpochRef.current += 1
    eventPipelineRef.current = Promise.resolve()
    if (playSourceRef.current) {
      try {
        playSourceRef.current.stop()
      } catch {
        /* 已播完/已停止時 stop() 會丟例外，忽略 */
      }
      playSourceRef.current = null
    }
  }, [])

  const safeSend = useCallback((payload) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload))
    } else {
      sendQueueRef.current.push(payload)
    }
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    dispatch({ type: 'connecting' })

    const url = `${WS_BASE}/ws/voice-debate/${sessionId}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      const pending = sendQueueRef.current.drain()
      pending.forEach((payload) => ws.send(JSON.stringify(payload)))
    }

    ws.onmessage = (evt) => {
      let payload
      try {
        payload = JSON.parse(evt.data)
      } catch {
        return
      }

      if (
        payload.type === 'agent_speaking_start' ||
        payload.type === 'agent_speaking_chunk' ||
        payload.type === 'agent_speaking_end'
      ) {
        const epoch = dispatchEpochRef.current
        eventPipelineRef.current = eventPipelineRef.current.then(async () => {
          if (dispatchEpochRef.current !== epoch) return
          dispatch(payload)
          if (payload.type === 'agent_speaking_chunk') {
            if (payload.audio) {
              await playAudioChunk(payload.audio, payload.sample_rate)
            }
          } else if (payload.type === 'agent_speaking_end') {
            // 這一輪真的播完了 → 回報後端放行（預生成好的）下一輪
            safeSend(buildTurnPlayedMessage(payload.agent_id))
          }
        })
        return
      }

      dispatch(payload)
    }

    ws.onclose = () => dispatch({ type: 'disconnected' })
    ws.onerror = () => dispatch({ type: 'error', message: 'WebSocket 連線發生錯誤' })
  }, [sessionId, playAudioChunk, safeSend])

  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  /** 開始這個情境的辯論（自訂議題 + 每情境回合上限）。 */
  const initDebateSession = useCallback(
    (topicTitle, agents, maxTurns) => {
      safeSend(buildInitDebateSessionMessage(topicTitle, agents, maxTurns))
    },
    [safeSend],
  )

  const pauseDebate = useCallback(() => {
    // 先讓使用者馬上聽不到聲音，再讓後端 cancel 背景生成（互不依賴順序）
    stopAllPlaybackImmediately()
    safeSend(buildPauseDebateMessage())
  }, [safeSend, stopAllPlaybackImmediately])

  const sendIntervention = useCallback(
    (text) => {
      safeSend(buildUserInterveneMessage(text))
    },
    [safeSend],
  )

  /** 語音介入：16kHz mono WAV base64（見 utils/wavRecorder.js）。 */
  const sendInterventionAudio = useCallback(
    (base64Wav) => {
      safeSend(buildUserInterveneAudioMessage(base64Wav))
    },
    [safeSend],
  )

  const endSession = useCallback(() => {
    stopAllPlaybackImmediately()
    safeSend(buildEndDebateSessionMessage())
  }, [safeSend, stopAllPlaybackImmediately])

  const reset = useCallback(() => {
    dispatch({ type: 'reset' })
  }, [])

  useEffect(() => () => disconnect(), [disconnect])

  return {
    state,
    connect,
    disconnect,
    initDebateSession,
    pauseDebate,
    sendIntervention,
    sendInterventionAudio,
    endSession,
    reset,
    getSpeakLevel,
  }
}
