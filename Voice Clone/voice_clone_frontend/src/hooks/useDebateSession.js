/**
 * useDebateSession.js — 辯論模式 WebSocket Hook
 *
 * 對接 /ws/voice-debate/{sessionId}（見 voice_clone_backend/routers/ws_debate.py）。
 * 跟 useVoiceAgentSession.js 的差異：
 *   - 固定兩位 agent、圍繞單一主題輪流發言，不需要 routing_strategy。
 *   - 音訊播放同一時間只有一個來源（playSourceRef）——辯論模式同一時間只會
 *     有一位 agent 在講話（交替發言，不是平行），暫停可以直接 stop() 掉
 *     正在播放的那個音訊來源。兩位 agent 的「聲音」本身仍然是分開的：
 *     真正的 TTS 音訊內容由各自的 voice_profile_id（克隆聲音）決定，
 *     瀏覽器 TTS 替代方案則依 agent_id 挑選不同的瀏覽器語音／語調（見
 *     utils/browserTts.js 的 pickVoiceIndexForAgent()）。
 *   - 暫停必須「立刻」讓使用者聽不到聲音，不能只是送出 pause_debate 訊息、
 *     等後端目前這輪生成/播放完才停：stopAllPlaybackImmediately() 直接
 *     停掉正在播放的音訊來源、取消瀏覽器 TTS 朗讀，跟送給後端的
 *     pause_debate（後端會 cancel 掉背景生成 task）一起，才是使用者感受
 *     到的「馬上安靜下來」。
 *   - 瀏覽器語音辨識（browserSttEnabled）：後端 user_intervene 訊息只吃
 *     文字，辯論模式沒有像一般多 Agent 對話那樣的 user_audio／後端 STT
 *     路徑（插話設計上就是文字）。開啟這個開關後，暫停畫面的「按住說話」
 *     會用 Web Speech API 就地辨識，辨識到最終結果就直接當插話送出
 *     （sendIntervention），不需要另外打字；不開的話一樣可以直接在
 *     文字框輸入插話內容，兩者互不衝突。直接比照 useVoiceAgentSession.js
 *     的 browserSttEnabled 開關做法。
 *
 * ── 事件序列化管線（修過的真實回報問題：時序對不齊、訊息顯示錯亂、暫停
 *    按了語音還是繼續播）──────────────────────────────────────────────
 *
 * 第一版做法是「收到事件時，捕捉當下的播放佇列 Promise，等它 settle 才
 * dispatch」，問題出在：如果同一輪裡好幾個 agent_speaking_chunk 事件抵達
 * 得很密集（例如 MockTTSService 幾乎瞬間吐出好幾個 chunk），第 2、3 個
 * chunk 抵達時，第 1 個 chunk 的「等待 settle」callback 可能都還沒真的
 * 執行到（只是排進微任務佇列），這時候它們捕捉到的會是「同一份、還沒被
 * 第 1 個 chunk 更新過」的舊佇列快照。等這份舊快照 settle（幾乎是立刻，
 * 因為它根本還沒被塞進任何真正要播放的音訊），第 1、2、3 個 chunk 的
 * dispatch 幾乎會在同一個時間點一起觸發——文字瞬間全部跳出來、跟音訊
 * 播放的實際進度完全脫勾，這解釋了「聲音/訊息/高亮對不齊」，也解釋了
 * 「換人發言時聊天視窗一次冒出好幾則訊息」的錯亂觀察。更嚴重的是，
 * 因為好幾個 chunk 的 dispatch 幾乎同時觸發，各自呼叫的
 * `window.speechSynthesis.speak()` 也會在極短時間內接連呼叫，導致瀏覽器
 * 原生的朗讀佇列一次塞進好幾句未播放的內容；`cancel()` 在這種「佇列裡
 * 還有好幾句排隊」的情況下，不同瀏覽器的行為不一致，常常只中斷「目前
 * 正在講」的那一句，佇列裡排隊的下一句馬上接著自動開始播放，使用者感覺
 * 起來就是「按了暫停，語音還是繼續講」。
 *
 * 修法：不再用「捕捉快照＋各自等待」，改成**單一嚴格序列化的事件管線**
 * （eventPipelineRef）。收到 agent_speaking_start / agent_speaking_chunk /
 * agent_speaking_end 時，一律用 `eventPipelineRef.current =
 * eventPipelineRef.current.then(processEvent)` 把這個事件的處理函式接在
 * 管線尾端——這一行是在 ws.onmessage 裡「同步」執行的，也就是說即使兩個
 * 事件幾乎同時抵達，第二個事件讀到的 `eventPipelineRef.current` 一定是
 * 第一個事件「剛剛已經接上」之後的最新值，不會有兩者讀到同一份舊快照的
 * 競態。每個事件的 processEvent 函式會：先檢查 epoch 沒有被暫停打斷，
 * 再 dispatch（顯示文字／切換高亮），如果是 chunk 事件還要 `await`
 * 這個 chunk 的音訊播放與瀏覽器朗讀都真的播完，才讓函式回傳——管線的
 * 下一個事件的 processEvent 要等這個 await 解決才會開始執行。這保證了
 * 任何時刻最多只有一個 chunk 在「播放中」，也保證任何時刻最多只有一句
 * 瀏覽器朗讀被排進 speechSynthesis 的原生佇列，`cancel()` 只需要中斷
 * 「當下這一句」就能讓一切安靜下來，不會有佇列裡還排著別的句子接著播的
 * 問題。
 *
 * dispatchEpochRef 是額外的保險：stopAllPlaybackImmediately()（暫停／
 * 結束時呼叫）會讓 epoch 遞增，管線裡任何「還沒真的 dispatch」的事件
 * 之後會發現 epoch 對不上而直接放棄（不 dispatch、不播放），避免暫停
 * 之後畫面突然冒出「暫停前那一輪」的殘留文字/高亮。強制停止目前播放的
 * 音訊來源／瀏覽器朗讀時，會觸發它們各自的 onended/onerror callback，
 * 讓「正在等待這個 chunk 播完」的 processEvent 提前解除等待、繼續往下
 * 走到下一個（epoch 已對不上、會被跳過的）事件，管線不會卡住。
 *
 * 真的接上 CosyVoice 2（模型生成 TTS）之後，這一整套序列化管線完全不需要
 * 改：音訊資料本身就是真的會播出來的聲音，AudioBufferSourceNode.stop()
 * 是同步、可靠的中斷方式，天生就比瀏覽器 SpeechSynthesis.cancel()（已知
 * 在部分瀏覽器/系統語音上、佇列有殘留內容時不保證整個佇列都被清空，是
 * 瀏覽器實作的已知限制，不是這裡程式碼的邏輯錯誤）更好掌握「現在播到
 * 哪裡」與「暫停時真的馬上停下來」；而且因為管線本來就保證同一時間只有
 * 一句在播放，即使換成真的模型 TTS，也不會有原生佇列塞車的問題。
 *
 * ── turn_played 回報（修過的真實回報問題：插話後接續回應的是錯的
 *    agent）──────────────────────────────────────────────────────────
 * 後端 agents/debate.py 的節奏控制只是「估計值」，如果開著瀏覽器語音朗讀，
 * 實際唸多久跟估計常常對不上；後端過去講完一輪就立刻開始生成下一輪，
 * 完全不管前端是不是真的聽完，很快就會跑到比使用者實際聽到的還前面。
 * 這時候使用者聽著（其實是舊的）某位 agent 的聲音按暫停，以為打斷的是他
 * 正在聽的那位，但後端當下真正在生成／被取消的其實是後面別輪的另一位
 * agent，插話後接續回應的自然對不上預期。
 *
 * 修法：`agent_speaking_end` 這個事件在事件序列化管線裡處理到的當下，
 * 代表這一輪的音訊/朗讀都已經真的播完了（管線保證前面的 chunk 事件都
 * 已經處理並 await 完畢）——這正是「回報給後端」的最佳時機點，所以這裡
 * 順手送出 `turn_played`。後端收到後才會繼續生成下一輪（見
 * routers/ws_debate.py 檔案開頭「等待前端回報播放完成」的說明），讓後端
 * 最多只會比前端領先一輪，暫停時中斷的 agent 就會跟使用者實際聽到、
 * 想打斷的那位一致。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { debateSessionReducer, initialDebateState } from '../store/debateSessionReducer'
import {
  buildEndDebateSessionMessage,
  buildInitDebateSessionMessage,
  buildPauseDebateMessage,
  buildTurnPlayedMessage,
  buildUserInterveneMessage,
} from '../api/voiceDebateClient'
import { createSendQueue } from '../utils/sendQueue'
import { isBrowserTtsSupported, speakWithBrowserTts } from '../utils/browserTts'
import { createBrowserSttSession, isBrowserSttSupported } from '../utils/browserStt'

const WS_BASE = import.meta.env.VITE_WS_BASE_URL || 'ws://localhost:8200'

export function useDebateSession(sessionId) {
  const [state, dispatch] = useReducer(debateSessionReducer, initialDebateState)
  // 開發用：後端 TTS 是 mock（靜音）時，用瀏覽器 Web Speech API 把 agent
  // 講的文字唸出來，方便測試暫停/插話的播放時序（跟 useVoiceAgentSession
  // 的同名開關是同一種用途，各自獨立管理狀態）。
  const [browserTtsEnabled, setBrowserTtsEnabled] = useState(false)
  const browserTtsEnabledRef = useRef(false)
  // 開發用／插話輸入替代方案：用瀏覽器語音辨識把「按住說話」講的內容
  // 直接轉成插話文字送出（見檔案開頭說明）。
  const [browserSttEnabled, setBrowserSttEnabled] = useState(false)
  const browserSttEnabledRef = useRef(false)
  const browserSttSessionRef = useRef(null)
  const [isRecording, setIsRecording] = useState(false)

  const wsRef = useRef(null)
  const sendQueueRef = useRef(createSendQueue())
  const audioContextRef = useRef(null)
  // 辯論模式同一時間只有一位 agent 在講話，只需要記住「目前正在播放的
  // 那個音訊來源」，暫停時才能直接 stop() 掉它。
  const playSourceRef = useRef(null)
  // 見檔案開頭「事件序列化管線」說明：所有 agent_speaking_* 事件都嚴格
  // 依抵達順序串接在這條管線上，一個處理完（含真的播完音訊/朗讀）才會
  // 換下一個開始處理。
  const eventPipelineRef = useRef(Promise.resolve())
  // 暫停/結束時遞增，讓管線裡還沒真的 dispatch 的事件事後發現 epoch
  // 對不上就放棄。
  const dispatchEpochRef = useRef(0)

  const toggleBrowserTts = useCallback((enabled) => {
    browserTtsEnabledRef.current = enabled
    setBrowserTtsEnabled(enabled)
  }, [])

  const toggleBrowserStt = useCallback((enabled) => {
    browserSttEnabledRef.current = enabled
    setBrowserSttEnabled(enabled)
  }, [])

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    return audioContextRef.current
  }, [])

  /** 播放單一 chunk 的音訊，回傳「這段音訊真的播完（或被強制中斷/解碼失敗）」才 resolve 的 Promise。 */
  const playAudioChunk = useCallback(
    (base64Audio) => {
      if (!base64Audio) return Promise.resolve()
      const ctx = getAudioContext()
      const binary = atob(base64Audio)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

      return new Promise((resolve) => {
        ctx.decodeAudioData(
          bytes.buffer.slice(0),
          (buffer) => {
            const source = ctx.createBufferSource()
            source.buffer = buffer
            source.connect(ctx.destination)
            source.onended = () => {
              if (playSourceRef.current === source) playSourceRef.current = null
              resolve()
            }
            playSourceRef.current = source
            source.start()
          },
          () => resolve(), // 解碼失敗（例如 mock 靜音資料）就跳過，不卡住管線
        )
      })
    },
    [getAudioContext],
  )

  /**
   * 用瀏覽器 TTS 唸出這個 chunk 的文字，回傳「唸完（或出錯）」才 resolve
   * 的 Promise。agentId 用來讓 pickVoiceIndexForAgent()（見 utils/browserTts.js）
   * 挑出不同的瀏覽器語音／語調，讓兩位 agent 的朗讀聲音有區隔，不會兩個人
   * 聽起來是同一個聲音（曾經的 bug：這裡以前固定傳入字串 'debate' 而不是
   * 實際的 agent_id，導致兩位 agent 選到同一個瀏覽器語音）。
   */
  const speakChunk = useCallback((agentId, text) => {
    if (!text) return Promise.resolve()
    return speakWithBrowserTts(text, agentId)
  }, [])

  /** 暫停/結束時呼叫：立刻停掉正在播放的音訊、取消瀏覽器朗讀，並讓管線裡排隊中的舊事件全部作廢。 */
  const stopAllPlaybackImmediately = useCallback(() => {
    // 先讓 epoch 作廢，管線裡任何「還沒真的 dispatch」的事件之後會發現
    // epoch 對不上而放棄，不會在暫停後突然冒出殘留的文字/高亮。
    dispatchEpochRef.current += 1
    // 管線本身也重置，讓暫停之後抵達的新事件從乾淨的狀態開始排隊（舊管線
    // 裡還沒處理完的部分會因為下面強制停止音訊/朗讀而很快自然結束，
    // 而且每個事件都會先檢查 epoch，就算舊管線還在跑也不會有可見副作用）。
    eventPipelineRef.current = Promise.resolve()
    if (playSourceRef.current) {
      try {
        playSourceRef.current.stop()
      } catch {
        // 音訊已經播完或已經停止時 stop() 可能丟例外，忽略即可
      }
      playSourceRef.current = null
    }
    // window.speechSynthesis.cancel() 在部分瀏覽器（尤其分頁曾經失去過
    // 焦點時）不保證立即中斷正在朗讀的 utterance，是瀏覽器實作本身的已知
    // 限制；保險起見連續呼叫兩次，實務上能提高立即中斷的成功率。因為
    // 事件序列化管線保證同一時間最多只有一句排在瀏覽器原生朗讀佇列裡
    // （見檔案開頭說明），這裡不會再遇到「佇列裡還有別句排隊、cancel()
    // 只清掉當下這句」的情況（若接上真正的模型生成 TTS，音訊改用
    // AudioBufferSourceNode 播放，上面的 .stop() 是同步、可靠的，也完全
    // 不會有這個問題）。
    window.speechSynthesis?.cancel()
    window.speechSynthesis?.cancel()
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

      // agent_speaking_start / agent_speaking_chunk / agent_speaking_end
      // 一律串進 eventPipelineRef，嚴格依抵達順序處理，見檔案開頭「事件
      // 序列化管線」說明。這一行本身是同步執行的，所以就算兩個事件幾乎
      // 同時抵達，也不會有競態：第二個事件一定會接在第一個事件「剛剛
      // 接上」的管線尾端，而不是讀到同一份舊快照。
      if (
        payload.type === 'agent_speaking_start' ||
        payload.type === 'agent_speaking_chunk' ||
        payload.type === 'agent_speaking_end'
      ) {
        const epoch = dispatchEpochRef.current
        eventPipelineRef.current = eventPipelineRef.current.then(async () => {
          // 排隊等待期間如果使用者按了暫停/結束（epoch 已經變了），這則
          // 事件視為過期，直接放棄，不會在暫停後突然冒出殘留內容。
          if (dispatchEpochRef.current !== epoch) return

          dispatch(payload)
          if (payload.type === 'agent_speaking_chunk') {
            const tasks = []
            if (payload.audio) tasks.push(playAudioChunk(payload.audio))
            if (payload.text && browserTtsEnabledRef.current) {
              tasks.push(speakChunk(payload.agent_id, payload.text))
            }
            if (tasks.length > 0) {
              await Promise.all(tasks)
            }
          } else if (payload.type === 'agent_speaking_end') {
            // 這一輪的音訊/朗讀都已經真的播完了（管線保證前面的 chunk
            // 事件都已經處理完），回報給後端讓它不要搶跑，見檔案開頭
            // 「turn_played 回報」說明。
            safeSend(buildTurnPlayedMessage(payload.agent_id))
          }
        })
        return
      }

      dispatch(payload)
    }

    ws.onclose = () => dispatch({ type: 'disconnected' })
    ws.onerror = () => dispatch({ type: 'error', message: 'WebSocket 連線發生錯誤' })
  }, [sessionId, playAudioChunk, speakChunk, safeSend])

  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  const initDebateSession = useCallback(
    (topicId, agents) => {
      safeSend(buildInitDebateSessionMessage(topicId, agents))
    },
    [safeSend],
  )

  const pauseDebate = useCallback(() => {
    // 先讓使用者「馬上聽不到聲音」，再送出 pause_debate 讓後端 cancel 掉
    // 背景生成 task（兩者互不依賴先後順序，但前端這步不需要等後端回應）。
    stopAllPlaybackImmediately()
    safeSend(buildPauseDebateMessage())
  }, [safeSend, stopAllPlaybackImmediately])

  const sendIntervention = useCallback(
    (text) => {
      safeSend(buildUserInterveneMessage(text))
    },
    [safeSend],
  )

  /**
   * 用瀏覽器語音辨識就地辨識使用者「按住說話」講的內容，辨識到最終結果就
   * 直接當插話送出（跟 useVoiceAgentSession.js 的 sendTextWithLocalEcho
   * 不同：這裡不需要本地回顯，因為後端會回 user_intervene_ack，reducer
   * 收到後自然會把這句話加進 transcript，不會像一般多 Agent 對話的
   * user_text 路徑那樣完全沒有回顯）。
   */
  const startRecording = useCallback(() => {
    if (!browserSttEnabledRef.current) return
    const session = createBrowserSttSession({
      lang: 'zh-TW',
      onFinalResult: (text) => {
        if (text && text.trim()) {
          sendIntervention(text.trim())
        }
      },
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
  }, [sendIntervention])

  const stopRecording = useCallback(() => {
    browserSttSessionRef.current?.stop()
    browserSttSessionRef.current = null
    setIsRecording(false)
  }, [])

  const endSession = useCallback(() => {
    stopAllPlaybackImmediately()
    safeSend(buildEndDebateSessionMessage())
  }, [safeSend, stopAllPlaybackImmediately])

  useEffect(() => () => disconnect(), [disconnect])

  return {
    state,
    connect,
    disconnect,
    initDebateSession,
    pauseDebate,
    sendIntervention,
    endSession,
    browserTtsEnabled,
    toggleBrowserTts,
    isBrowserTtsSupported: isBrowserTtsSupported(),
    browserSttEnabled,
    toggleBrowserStt,
    isBrowserSttSupported: isBrowserSttSupported(),
    isRecording,
    startRecording,
    stopRecording,
  }
}
