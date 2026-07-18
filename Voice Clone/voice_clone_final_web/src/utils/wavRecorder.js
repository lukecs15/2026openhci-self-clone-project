/**
 * wavRecorder.js — 介入用麥克風錄音 → 16kHz mono WAV base64
 *
 * 為什麼不用 MediaRecorder：MediaRecorder 輸出 webm/ogg 容器，後端 STT
 * 走 soundfile 直讀時要靠 PyAV fallback 解容器，多一層轉檔延遲與失敗點。
 * Unity VR 版的插話錄音固定是 16kHz mono WAV（見 PROJECT_ARCHITECTURE.md
 * 「跨端共用的設計約定」），這裡比照同一格式：AudioContext 取得原始
 * Float32 PCM → 線性重取樣到 16kHz → Int16 → 自己寫 WAV header → base64，
 * 後端 user_intervene_audio 收到後 soundfile 直讀，路徑最短、延遲最低。
 *
 * ScriptProcessorNode 已被標記 deprecated，但所有目標瀏覽器（展場用
 * Chrome/Edge）都還支援，而且不需要額外的 AudioWorklet 檔案部署，對
 * 展場環境最穩。真的被移除時再換 AudioWorklet 版本即可（介面不變）。
 */

const TARGET_SAMPLE_RATE = 16000

function downsampleTo16k(float32, sourceRate) {
  if (sourceRate === TARGET_SAMPLE_RATE) return float32
  const ratio = sourceRate / TARGET_SAMPLE_RATE
  const outLength = Math.floor(float32.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, float32.length - 1)
    const frac = pos - i0
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac
  }
  return out
}

function encodeWav16kMono(float32) {
  const numSamples = float32.length
  const dataSize = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buffer
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * 建立一次性的錄音 session。
 *
 * 用法：
 *   const rec = await createWavRecorder()   // 這裡會請求麥克風權限
 *   rec.start()
 *   ...（使用者按住說話）...
 *   const { base64, durationMs } = await rec.stop()  // 同時釋放麥克風
 *
 * @throws getUserMedia 失敗時往外拋（呼叫端顯示「請改用文字輸入」的備援）
 */
export async function createWavRecorder() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })

  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const chunks = []
  let recording = false

  processor.onaudioprocess = (evt) => {
    if (!recording) return
    // 必須複製：AudioBuffer 的底層記憶體會被重複使用
    chunks.push(new Float32Array(evt.inputBuffer.getChannelData(0)))
  }

  source.connect(processor)
  // ScriptProcessor 需要接到 destination 才會被驅動；經過零增益節點避免回授
  const silent = ctx.createGain()
  silent.gain.value = 0
  processor.connect(silent)
  silent.connect(ctx.destination)

  return {
    start() {
      recording = true
    },
    async stop() {
      recording = false
      processor.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      const sourceRate = ctx.sampleRate
      await ctx.close()

      const total = chunks.reduce((n, c) => n + c.length, 0)
      const merged = new Float32Array(total)
      let offset = 0
      for (const c of chunks) {
        merged.set(c, offset)
        offset += c.length
      }
      const resampled = downsampleTo16k(merged, sourceRate)
      return {
        base64: arrayBufferToBase64(encodeWav16kMono(resampled)),
        durationMs: (resampled.length / TARGET_SAMPLE_RATE) * 1000,
      }
    },
    cancel() {
      recording = false
      try {
        processor.disconnect()
        source.disconnect()
      } catch {
        /* 已經斷開就算了 */
      }
      stream.getTracks().forEach((t) => t.stop())
      ctx.close()
    },
  }
}
