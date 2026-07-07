/**
 * sendQueue.js — WebSocket 訊息佇列（純函式，方便單元測試）
 *
 * 修的一個真實 bug：之前 initSession() 是在 connect() 之後用固定的
 * setTimeout(300ms) 延遲呼叫，賭 WebSocket 在 300ms 內一定會連上。
 * 但 handshake 時間不保證，一旦連線還沒 OPEN，ws.send() 會直接丟出
 * InvalidStateError，訊息整個遺失，導致後端永遠沒收到 init_session，
 * 之後每則 user_audio / user_text 都會被後端回報「尚未 init_session」。
 *
 * 這個佇列讓呼叫端不用管連線是否已經 OPEN：readyState 還沒 OPEN 時
 * 先把訊息放進佇列，等 onopen 觸發時再依序 drain 出來送出。
 */

export function createSendQueue() {
  let queue = []
  return {
    push(payload) {
      queue.push(payload)
    },
    /** 取出目前佇列裡所有訊息，並清空佇列（依加入順序）。 */
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
