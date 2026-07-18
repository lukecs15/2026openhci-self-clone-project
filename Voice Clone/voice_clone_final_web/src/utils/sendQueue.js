/**
 * sendQueue.js — WebSocket 訊息佇列
 *
 * 與 voice_clone_frontend/src/utils/sendQueue.js 同一份實作：連線還沒 OPEN
 * 時先排隊，onopen 再依序送出，避免 handshake 期間 ws.send() 直接丟
 * InvalidStateError 導致 init 訊息遺失（修過的真實 bug，詳見原檔案說明）。
 */
export function createSendQueue() {
  let queue = []
  return {
    push(payload) {
      queue.push(payload)
    },
    drain() {
      const items = queue
      queue = []
      return items
    },
    size() {
      return queue.length
    },
  }
}
