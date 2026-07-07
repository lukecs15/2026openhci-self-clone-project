/**
 * agentSpeakingSync.js — 讓「agent 發話中」高亮對齊實際播放時間
 *
 * 背景：後端 agent_speaking_end 事件是「這個 agent 的文字/音訊都生成完畢」
 * 就立刻送出，跟音訊有沒有真的播完無關；MockTTSService 甚至用
 * asyncio.sleep(0) 幾乎瞬間生成完所有 chunk（見 tts_service.py 說明）。
 * 如果收到 agent_speaking_end 就立刻把 UI 的「發話中」高亮收掉，框框亮著
 * 的時間反映的是「後端生成完了沒」，不是「使用者聽到的聲音播完了沒」。
 *
 * 這裡把「等待播放真正結束」的純邏輯抽出來：給定目前這個 agent 的音訊
 * 播放佇列 Promise、瀏覽器 TTS 朗讀佇列 Promise（兩者都可能是 undefined，
 * 代表這個 agent 這輪根本沒有東西要播），回傳一個「兩者都播完才 resolve」
 * 的 Promise，呼叫端（useVoiceAgentSession.js）收到 agent_speaking_end 時
 * 用這個 Promise 決定何時才真的把高亮收掉。
 */
export function waitForPlaybackToSettle(audioQueuePromise, speechQueuePromise) {
  const audioDone = audioQueuePromise || Promise.resolve()
  const speechDone = speechQueuePromise || Promise.resolve()
  return Promise.all([audioDone, speechDone])
}
