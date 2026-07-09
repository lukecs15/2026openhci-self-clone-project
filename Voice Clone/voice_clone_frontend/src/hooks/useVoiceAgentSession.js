/**
 * useVoiceAgentSession.js — 多 Agent 語音對話 WebSocket Hook
 *
 * 負責：
 * - 連接/斷開 WebSocket（ws://<host>/ws/voice-agents/{sessionId}）
 * - 送出 init_session / user_text / user_audio / end_session
 * - 把收到的 server 訊息 dispatch 進 agentSessionReducer，驅動 UI 狀態
 * - 管理麥克風錄音（MediaRecorder，或瀏覽器 Web Speech API 辨識——見下方
 *   browserSttEnabled 說明）
 * - 串流播放各 agent 的 TTS 音訊 chunk（base64 → AudioContext 播放佇列，
 *   依 agent_id 分開排隊，避免不同 agent 的音訊互相打斷）
 *
 * 狀態轉換邏輯本身在 store/agentSessionReducer.js（純函式，已有 vitest 測試），
 * 這個 hook 只負責「接線」：WebSocket 事件 → dispatch → reducer 更新狀態。
 *
 * 送出訊息一律走 safeSend()：連線還沒 OPEN 時先進佇列（見 utils/sendQueue.js），
 * onopen 時自動 drain 送出，呼叫端（例如 VoiceAgentsPage）不需要自己猜測
 * 連線何時準備好，也不會像先前版本一樣因為固定 setTimeout 而漏送 init_session。
 *
 * 注意：後端 user_transcript 事件只會在 user_audio（真的送音訊給後端 STT）
 * 這條路徑出現；純文字輸入（sendText）或瀏覽器端 STT 辨識完直接送 user_text
 * 時，後端不會回傳對應的使用者發言事件。這裡統一在送出當下就地（optimistic）
 * dispatch 一筆 user_transcript 給 reducer，讓「你輸入了什麼」一定會顯示在
 * 對話紀錄裡，不用等後端回應、也不會因為沒有 user_audio 而完全不顯示。
 *
 * 注意：agent_speaking_end 事件代表「後端生成完畢」，不代表「音訊已經播完」
 * （見 utils/agentSpeakingSync.js 說明）。這裡收到 agent_speaking_end 時
 * 不會立刻 dispatch，而是等該 agent 目前排進佇列的音訊／瀏覽器 TTS 朗讀都
 * 播放完才 dispatch，讓 AgentStage 的「發話中」高亮對齊使用者實際聽到的
 * 播放時間，而不是後端生成速度。
 *
 * 注意：瀏覽器 TTS 朗讀（speechQueueRef）用「單一全域佇列」而不是像音訊
 * 播放（playQueuesRef）那樣依 agent 分開排隊。原因是 window.speechSynthesis
 * 本身是整個分頁共用的單一朗讀引擎，同時排好幾個 agent 各自獨立的佇列會讓
 * 好幾個 .speak() 呼叫在差不多的時間點各自送進瀏覽器同一個底層佇列，實際
 * 播放順序會依呼叫時間點交錯，跟聊天視窗上乾淨的「小明→小華→阿德」順序
 * 對不起來（尤其 Job Group 平行模式，多個 agent 幾乎同時在生成文字）。
 * 改成單一全域佇列後，朗讀順序會跟 agent_speaking_chunk 事件抵達（也就是
 * 聊天紀錄顯示）的順序完全一致，不會有人聲交錯的問題；唯一的取捨是同一
 * 時間只會有一個 agent 的聲音在唸，不會真的「同時朗讀」——但 Web Speech
 * API 本來就無法真正同時朗讀多個聲音，這個取捨是必要的。真正的音訊播放
 * （playQueuesRef，未來接上 CosyVoice 2 時的真實/mock 音訊）不受影響，
 * 仍然是每個 agent 各自獨立播放，可以真的同時發聲。
 *
 * ── 結束對話要立刻打斷正在播放的聲音（修過的真實回報問題）──────────────
 * 第一版 endSession() 只是送出 end_session 訊息，沒有做任何本地停止播放的
 * 動作——跟辯論模式的 useDebateSession.js 不一樣，辯論模式一開始就需要
 * 「暫停」這個互動（stopAllPlaybackImmediately()），一般多 Agent 對話原本
 * 沒有中途打斷的需求，所以完全沒有這一塊。新增結束按鈕之後，使用者實測
 * 發現按下「結束對話」時，如果剛好有 agent 正在講話，聲音會繼續播完，沒有
 * 立刻安靜下來。原因有兩個，都要處理：
 *   1. 本地已經排進 playQueuesRef／speechQueueRef 佇列、甚至正在播放的音訊
 *      /瀏覽器朗讀，endSession() 完全沒有去停止它們。
 *   2. 後端 ws_voice_agents.py 的主收訊迴圈在處理 user_text 時是「同步跑完
 *      這一輪所有 agent 的完整回覆才會再去收下一則訊息」（不像辯論模式特地
 *      用背景 asyncio.Task 讓暫停可以插隊），所以就算送出 end_session，
 *      後端也要等目前這輪生成完全跑完才會真的處理它，這段期間陸續送達的
 *      agent_speaking_chunk 事件如果前端沒有擋掉，一樣會被排進佇列播放。
 * 修法（跟 useDebateSession.js 的 stopAllPlaybackImmediately() 同樣思路，
 * 額外多一個「已結束」旗標處理第 2 點）：
 *   - stopAllPlaybackImmediately()：立刻 stop() 掉每個 agent 目前正在播放
 *     的 AudioBufferSourceNode（activeSourcesRef 記錄每個 agent「目前
 *     正在播放的那個」）、cancel() 瀏覽器朗讀、讓 playbackEpochRef 遞增，
 *     使佇列裡任何「還沒真的開始播放」的項目之後執行到時直接跳過（用法
 *     跟 useDebateSession.js 的 dispatchEpochRef 相同概念）。
 *   - sessionEndedRef：endSession() 呼叫時設成 true，之後（理論上因為
 *     第 2 點）陸續抵達的 agent_speaking_chunk 一律不再排進播放佇列——
 *     不只是「停掉現在在播的」，是「結束之後收到的新音訊也不要播」。
 *     下一次 connect()（重新開始新的一場對話）會重置回 false。
 *
 * TODO: 加入 WebSocket 自動重連
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { agentSessionReducer, initialSessionState } from '../store/agentSessionReducer'
import {
  buildEndSessionMessage,
  buildInitSessionMessage,
  buildUserAudioMessage,
  buildUserTextMessage,
} from '../api/voiceAgentClient'
import { createSendQueue } from '../utils/sendQueue'
import { isBrowserTtsSupported, speakWithBrowserTts } from '../utils/browserTts'
import { createBrowserSttSession, isBrowserSttSupported } from '../utils/browserStt'
import { waitForPlaybackToSettle } from '../utils/agentSpeakingSync'

const WS_BASE = import.meta.env.VITE_WS_BASE_URL || 'ws://localhost:8200'

export function useVoiceAgentSession(sessionId) {
  const [state, dispatch] = useReducer(agentSessionReducer, initialSessionState)
  const [isRecording, setIsRecording] = useState(false)
  // 開發用：TTS 還是 mock（靜音）時，可以另外用瀏覽器 Web Speech API 把
  // agent 講的文字唸出來，方便測試播放時序。跟後端 TTS 是否 mock 無關，
  // 純粹是前端的測試輔助開關，預設關閉。
  const [browserTtsEnabled, setBrowserTtsEnabled] = useState(false)
  const browserTtsEnabledRef = useRef(false)
  // 開發用：後端 STT 設成 mock 時，MockSTTEngine 永遠回傳固定文字，沒辦法
  // 測試「說了什麼 → 對應回覆」這條路徑。開這個開關後，「按住說話」改用
  // 瀏覽器 Web Speech API 就地辨識，辨識完直接以 user_text 送出，完全繞過
  // 後端 STT（不管後端 STT 是 mock 還是真的雙引擎），純粹是前端測試替代方案。
  const [browserSttEnabled, setBrowserSttEnabled] = useState(false)
  const browserSttEnabledRef = useRef(false)
  const browserSttSessionRef = useRef(null)

  const wsRef = useRef(null)
  const sendQueueRef = useRef(createSendQueue())
  const audioContextRef = useRef(null)
  // 每個 agent 各自一條播放佇列，避免不同 agent 同時發話時音訊互相打斷
  const playQueuesRef = useRef({})
  // 瀏覽器 TTS 朗讀改用「單一全域佇列」，理由見檔案開頭說明（window.speechSynthesis
  // 是整個分頁共用的單一引擎，分開排隊會導致跨 agent 播放順序交錯）。
  const speechQueueRef = useRef(Promise.resolve())
  // 每個 agent「目前正在播放」的 AudioBufferSourceNode，結束對話時要能
  // 直接 stop() 掉它們（見檔案開頭「結束對話要立刻打斷正在播放的聲音」說明）。
  const activeSourcesRef = useRef({})
  // 結束對話時遞增，讓佇列裡還沒真的開始播放的音訊/朗讀之後執行到時直接
  // 跳過，不會在「結束」之後又冒出殘留的聲音。
  const playbackEpochRef = useRef(0)
  // 已經按下結束對話：之後（理論上因為後端還在跑完目前這輪）陸續抵達的
  // agent_speaking_chunk 一律不再排進播放佇列。
  const sessionEndedRef = useRef(false)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])

  const toggleBrowserTts = useCallback((enabled) => {
    browserTtsEnabledRef.current = enabled
    setBrowserTtsEnabled(enabled)
  }, [])

  const toggleBrowserStt = useCallback((enabled) => {
    browserSttEnabledRef.current = enabled
    setBrowserSttEnabled(enabled)
  }, [])

  const enqueueSpeechForAgent = useCallback((agentId, text) => {
    if (!text) return
    // 捕捉當下的 epoch：等這句真的輪到要唸的時候，如果使用者已經按了結束
    // 對話（epoch 已經被 stopAllPlaybackImmediately() 遞增），就直接跳過，
    // 不要在「結束」之後才冒出這句話的朗讀聲。
    const epoch = playbackEpochRef.current
    speechQueueRef.current = speechQueueRef.current.then(() => {
      if (playbackEpochRef.current !== epoch) return Promise.resolve()
      return speakWithBrowserTts(text, agentId)
    })
  }, [])

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    return audioContextRef.current
  }, [])

  const enqueueAudioForAgent = useCallback(
    async (agentId, base64Audio) => {
      if (!base64Audio) return
      const ctx = getAudioContext()
      const binary = atob(base64Audio)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

      // 見 enqueueSpeechForAgent 的同樣理由：捕捉當下 epoch，執行到這個
      // chunk 時如果 epoch 已經對不上（結束對話期間被作廢），直接跳過。
      const epoch = playbackEpochRef.current
      if (!playQueuesRef.current[agentId]) {
        playQueuesRef.current[agentId] = Promise.resolve()
      }
      playQueuesRef.current[agentId] = playQueuesRef.current[agentId].then(
        () =>
          new Promise((resolve) => {
            if (playbackEpochRef.current !== epoch) {
              resolve()
              return
            }
            ctx.decodeAudioData(
              bytes.buffer.slice(0),
              (buffer) => {
                if (playbackEpochRef.current !== epoch) {
                  resolve()
                  return
                }
                const source = ctx.createBufferSource()
                source.buffer = buffer
                source.connect(ctx.destination)
                source.onended = () => {
                  if (activeSourcesRef.current[agentId] === source) {
                    delete activeSourcesRef.current[agentId]
                  }
                  resolve()
                }
                activeSourcesRef.current[agentId] = source
                source.start()
              },
              () => resolve(), // 解碼失敗（例如 mock 靜音資料）就跳過，不中斷佇列
            )
          }),
      )
    },
    [getAudioContext],
  )

  /**
   * 立刻停掉所有 agent 目前正在播放的音訊、取消瀏覽器朗讀，並讓佇列裡還
   * 沒真的開始播放的項目全部作廢——結束對話（endSession）時呼叫。跟
   * useDebateSession.js 的同名函式思路相同，差別是這裡要同時處理「多個
   * agent 各自的播放佇列」（辯論模式同一時間只有一位 agent 在講話，一般
   * 多 Agent 對話的 Job Group 平行模式可能好幾個 agent 同時在播）。
   */
  const stopAllPlaybackImmediately = useCallback(() => {
    playbackEpochRef.current += 1
    playQueuesRef.current = {}
    speechQueueRef.current = Promise.resolve()

    Object.values(activeSourcesRef.current).forEach((source) => {
      try {
        source.stop()
      } catch {
        // 音訊已經播完或已經停止時 stop() 可能丟例外，忽略即可
      }
    })
    activeSourcesRef.current = {}

    // window.speechSynthesis.cancel() 在部分瀏覽器不保證立即中斷，保險起見
    // 連續呼叫兩次（見 useDebateSession.js 的同一處理法說明）。
    window.speechSynthesis?.cancel()
    window.speechSynthesis?.cancel()
  }, [])

  /** 連線 OPEN 時直接送出；還沒 OPEN 就先排進佇列，等 onopen 再 drain。 */
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
    // 開始新的一場對話：重置「已結束」旗標，避免上一場按過結束對話之後，
    // 這一場的音訊/朗讀被誤判成「結束後陸續抵達的殘留事件」而被跳過。
    sessionEndedRef.current = false
    dispatch({ type: 'connecting' })

    const url = `${WS_BASE}/ws/voice-agents/${sessionId}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      // 連線正式建立後，把 connect() 到現在這段期間排隊的訊息（通常是
      // init_session）依序送出，避免像先前用 setTimeout 賭連線速度那樣漏送。
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

      if (payload.type === 'agent_speaking_end') {
        // 不立刻 dispatch：先等這個 agent 目前排進佇列的音訊／瀏覽器 TTS
        // 朗讀都播完，才真的把「發話中」高亮收掉（見檔案開頭說明 +
        // utils/agentSpeakingSync.js）。此時該收的 agent_speaking_chunk
        // 事件都已經處理完、佇列裡已經包含這一輪所有內容，直接讀取當下
        // 的佇列 Promise 即可。
        waitForPlaybackToSettle(
          playQueuesRef.current[payload.agent_id],
          speechQueueRef.current,
        ).then(() => dispatch(payload))
        return
      }

      dispatch(payload)
      // 已經按下結束對話：後端可能還在跑完目前這一輪才會真的處理
      // end_session（見檔案開頭「結束對話要立刻打斷正在播放的聲音」說明），
      // 這段期間陸續送達的音訊/文字不再排進播放佇列，避免結束之後又冒出
      // 新的聲音。
      if (sessionEndedRef.current) return
      if (payload.type === 'agent_speaking_chunk' && payload.audio) {
        enqueueAudioForAgent(payload.agent_id, payload.audio)
      }
      // text 只會出現在該句的第一個 chunk（見後端 _synthesize_and_wrap 的修正），
      // 所以這裡不會把同一句話唸兩次；瀏覽器 TTS 開關開著時才會唸。
      if (payload.type === 'agent_speaking_chunk' && payload.text && browserTtsEnabledRef.current) {
        enqueueSpeechForAgent(payload.agent_id, payload.text)
      }
    }

    ws.onclose = () => dispatch({ type: 'disconnected' })
    ws.onerror = () => dispatch({ type: 'error', message: 'WebSocket 連線發生錯誤' })
  }, [sessionId, enqueueAudioForAgent, enqueueSpeechForAgent])

  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  /**
   * routingStrategy 不傳（undefined）時，buildInitSessionMessage 會讓
   * routing_strategy 欄位在 JSON 裡直接消失，後端 ws_voice_agents.py 收到
   * 沒有這個欄位的 init_session 時，會用後端 .env 的 AGENT_ROUTING_STRATEGY
   * 設定值，而不是被寫死成固定的某個策略（修過的 bug：過去這裡預設值是
   * 'heuristic'，等於前端每次都主動要求 heuristic，完全蓋掉後端設定，
   * 就算 .env 設成 llm_decision 也永遠不會生效）。
   */
  const initSession = useCallback(
    (agents, routingStrategy) => {
      safeSend(buildInitSessionMessage(agents, routingStrategy))
    },
    [safeSend],
  )

  /**
   * 送出一段使用者文字，並且「就地」在前端把這句話加進對話紀錄（見檔案開頭
   * 說明：後端 user_text 路徑不會回傳 user_transcript 事件，不自己補上的話
   * 畫面上會完全看不到使用者剛剛送出了什麼）。
   * source 只是拿來標示這句話是怎麼來的（typed / browser_stt），純粹顯示用途。
   */
  const sendTextWithLocalEcho = useCallback(
    (text, source = 'typed') => {
      dispatch({ type: 'user_transcript', text, engine_used: source, used_fallback: false })
      safeSend(buildUserTextMessage(text))
    },
    [safeSend],
  )

  const sendText = useCallback(
    (text) => {
      sendTextWithLocalEcho(text, 'typed')
    },
    [sendTextWithLocalEcho],
  )

  const sendAudioBase64 = useCallback(
    (base64Audio) => {
      safeSend(buildUserAudioMessage(base64Audio))
    },
    [safeSend],
  )

  const endSession = useCallback(() => {
    // 先讓使用者「馬上聽不到聲音」，再送出 end_session（見檔案開頭「結束
    // 對話要立刻打斷正在播放的聲音」說明；跟 useDebateSession.js 的
    // endSession() 同樣的順序考量，前端這步不需要等後端回應）。
    sessionEndedRef.current = true
    stopAllPlaybackImmediately()
    safeSend(buildEndSessionMessage())
  }, [safeSend, stopAllPlaybackImmediately])

  /**
   * 結束畫面（SessionSummaryScreen）按下離開按鈕時呼叫：把 reducer 狀態
   * 重置回 initialSessionState，避免下一次重新開始對話時，畫面殘留上一場
   * 對話的 transcript／summaryText／status（見 disconnect() 之後接著呼叫）。
   */
  const reset = useCallback(() => {
    dispatch({ type: 'reset' })
  }, [])

  const startMediaRecorderRecording = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(stream)
    audioChunksRef.current = []
    recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data)
    recorder.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
      const buffer = await blob.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buffer)
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
      sendAudioBase64(btoa(binary))
      stream.getTracks().forEach((t) => t.stop())
    }
    recorder.start()
    mediaRecorderRef.current = recorder
    setIsRecording(true)
  }, [sendAudioBase64])

  /**
   * 瀏覽器 STT 開關開著時的錄音路徑：不走 MediaRecorder/user_audio，改用
   * Web Speech API 就地辨識，辨識到最終結果就直接當成 user_text 送出。
   * 這樣不管後端 STT 目前是 mock 還是真的雙引擎，都能用「你真的說的話」
   * 驅動多 Agent 回覆，方便在還沒接上麥克風真的能用的環境測試對話邏輯。
   */
  const startBrowserSttRecording = useCallback(() => {
    const session = createBrowserSttSession({
      lang: 'zh-TW',
      onFinalResult: (text) => sendTextWithLocalEcho(text, 'browser_stt'),
      onEnd: () => setIsRecording(false),
      onError: () => setIsRecording(false),
    })
    if (!session) {
      dispatch({ type: 'error', message: '目前瀏覽器不支援語音辨識（Web Speech API）' })
      return
    }
    browserSttSessionRef.current = session
    session.start()
    setIsRecording(true)
  }, [sendTextWithLocalEcho])

  const startRecording = useCallback(async () => {
    if (browserSttEnabledRef.current) {
      startBrowserSttRecording()
      return
    }
    await startMediaRecorderRecording()
  }, [startBrowserSttRecording, startMediaRecorderRecording])

  const stopRecording = useCallback(() => {
    if (browserSttEnabledRef.current) {
      browserSttSessionRef.current?.stop()
      browserSttSessionRef.current = null
      return
    }
    mediaRecorderRef.current?.stop()
    setIsRecording(false)
  }, [])

  useEffect(() => () => disconnect(), [disconnect])

  return {
    state,
    isRecording,
    connect,
    disconnect,
    initSession,
    sendText,
    sendAudioBase64,
    endSession,
    reset,
    startRecording,
    stopRecording,
    browserTtsEnabled,
    toggleBrowserTts,
    isBrowserTtsSupported: isBrowserTtsSupported(),
    browserSttEnabled,
    toggleBrowserStt,
    isBrowserSttSupported: isBrowserSttSupported(),
  }
}
