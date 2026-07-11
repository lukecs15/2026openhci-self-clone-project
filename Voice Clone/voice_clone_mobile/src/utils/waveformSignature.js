/**
 * waveformSignature.js — 每位 agent 的「波形人格簽章」
 *
 * 直接從 voice_clone_frontend/src/utils/waveformSignature.js 移植過來
 * （純函式、跟 React/DOM 無關，兩邊行為必須完全一致，才能讓後端算出的
 * waveform_signature 在桌機展示端跟手機紀念畫面上呈現同一個顏色/形狀）。
 * 手機這邊只會用到 `getWaveformSignature()`（讀後端回傳的
 * agent.waveform_signature 覆寫欄位）與 `mergeWaveformSignatures()`
 * （融合波形），但保留完整檔案內容以維持跟桌機端一致、之後好對照維護。
 *
 * ── 接線點：之後問卷流程 ──────────────────────────────────────────────
 * 之後如果 agent 物件（AgentConfig）上帶有 `waveform_signature` 欄位
 * （結構跟這裡回傳的物件一樣：{ frequency, amplitude, waveHeight,
 * waveformShape, hue, colorIntensity }，來源是使用者填問卷後算出來的真實
 * 數值），這個函式會直接優先採用該欄位、完全略過 preset 挑選邏輯——呼叫端
 * （WaveformAvatar / AgentStage）不需要跟著改，只要 agent 物件多了這個
 * 欄位就會自動生效。
 *
 * ── 情緒訊號 ────────────────────────────────────────────────────────
 * 這裡的簽章只代表「角色一直以來大致是什麼樣子」的基準波形；對話過程中
 * 每一輪話語的情緒起伏是另外一層（見 utils/emotionSignal.js 的
 * analyzeTurnEmotion()），用 applyEmotionSignal() 疊加在基準簽章上，
 * 兩者刻意分開設計，職責不同。`colorIntensity`（顏色的飽和度/明亮度整體
 * 強度）是額外的一個維度，跟 hue 分開：hue 決定「顏色偏向哪裡」（角色
 * 一直以來的特質，見上表），colorIntensity 決定「這個顏色現在有多鮮明」
 * （純粹是情緒驅動，見 emotionSignal.js 的 intensityDelta），所以這裡的
 * 基準值（BASE_COLOR_INTENSITY）對所有角色都一樣，不像 hue 是 preset
 * 挑出來的角色特質。
 */

// 六個預先設計好的「波形人格」原型，每一項的五個參數都是刻意依照心理意義
// 表格挑的（不是隨機生成）。手機端理論上一定會收到後端算好的
// waveform_signature 覆寫欄位（見 voice_clone_backend/services/
// personality_mapping.py），這組 preset 只是防呆保底（例如後端資料
// 缺欄位時）。
const PRESETS = [
  {
    name: '沉穩',
    frequency: 0.8,
    amplitude: 0.22,
    waveHeight: 0.95,
    waveformShape: 0.15,
    hue: 200, // 冷靜的藍
  },
  {
    name: '焦慮',
    frequency: 2.4,
    amplitude: 0.38,
    waveHeight: 0.6,
    waveformShape: 0.75,
    hue: 28, // 偏橘紅的緊繃感
  },
  {
    name: '溫暖包容',
    frequency: 1.1,
    amplitude: 0.3,
    waveHeight: 0.75,
    waveformShape: 0.3,
    hue: 34, // 暖橘
  },
  {
    name: '果斷主導',
    frequency: 1.6,
    amplitude: 0.45,
    waveHeight: 1.0,
    waveformShape: 0.4,
    hue: 350, // 強烈的紅
  },
  {
    name: '靈動幽默',
    frequency: 2.0,
    amplitude: 0.34,
    waveHeight: 0.7,
    waveformShape: 0.65,
    hue: 95, // 明亮的黃綠
  },
  {
    name: '內斂低語',
    frequency: 0.6,
    amplitude: 0.18,
    waveHeight: 0.55,
    waveformShape: 0.1,
    hue: 255, // 深沉的紫藍
  },
]

const BOUNDS = {
  frequency: [0.4, 3.0],
  amplitude: [0.1, 0.6],
  waveHeight: [0.4, 1.0],
  waveformShape: [0, 1],
  colorIntensity: [0.2, 1],
}

const BASE_COLOR_INTENSITY = 0.55

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function hashString(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function jitterFactor(seed) {
  const h = hashString(seed)
  return ((h % 2001) - 1000) / 1000
}

/**
 * 取得某個 agent 的波形簽章。優先採用 agent.waveform_signature（後端
 * 算好的真實數值），沒有的話 fallback 用 agent_id 雜湊挑一個決定性的 preset。
 *
 * @param {{ agent_id?: string, display_name?: string, waveform_signature?: object }} agent
 */
export function getWaveformSignature(agent) {
  if (agent && agent.waveform_signature) {
    return agent.waveform_signature
  }

  const key = (agent && (agent.agent_id || agent.display_name)) || 'default-agent'
  const seed = hashString(key)
  const preset = PRESETS[seed % PRESETS.length]

  const freqJitter = jitterFactor(`${key}:frequency`) * 0.15
  const ampJitter = jitterFactor(`${key}:amplitude`) * 0.15
  const heightJitter = jitterFactor(`${key}:waveHeight`) * 0.12
  const shapeJitter = jitterFactor(`${key}:waveformShape`) * 0.2
  const hueJitter = jitterFactor(`${key}:hue`) * 20
  const colorIntensityJitter = jitterFactor(`${key}:colorIntensity`) * 0.15

  return {
    presetName: preset.name,
    frequency: clamp(preset.frequency * (1 + freqJitter), ...BOUNDS.frequency),
    amplitude: clamp(preset.amplitude * (1 + ampJitter), ...BOUNDS.amplitude),
    waveHeight: clamp(preset.waveHeight * (1 + heightJitter), ...BOUNDS.waveHeight),
    waveformShape: clamp(preset.waveformShape + shapeJitter, ...BOUNDS.waveformShape),
    hue: (Math.round(preset.hue + hueJitter) + 360) % 360,
    colorIntensity: clamp(BASE_COLOR_INTENSITY + colorIntensityJitter, ...BOUNDS.colorIntensity),
  }
}

/**
 * 把單輪情緒訊號疊加在角色的基準波形簽章上，回傳一組新的（clamp 過的）簽章。
 * 刻意不改動 `waveHeight`（見 voice_clone_frontend 同名函式的說明）。
 */
export function applyEmotionSignal(baseSignature, emotion) {
  if (!emotion) return baseSignature
  return {
    ...baseSignature,
    frequency: clamp(baseSignature.frequency + (emotion.frequencyDelta || 0), ...BOUNDS.frequency),
    amplitude: clamp(baseSignature.amplitude + (emotion.amplitudeDelta || 0), ...BOUNDS.amplitude),
    waveformShape: clamp(baseSignature.waveformShape + (emotion.shapeDelta || 0), ...BOUNDS.waveformShape),
    hue: (Math.round(baseSignature.hue + (emotion.hueDelta || 0)) + 360) % 360,
    colorIntensity: clamp(
      (baseSignature.colorIntensity ?? BASE_COLOR_INTENSITY) + (emotion.intensityDelta || 0),
      ...BOUNDS.colorIntensity,
    ),
  }
}

/**
 * 逐欄位把目前的波形簽章平滑地往目標簽章移動一小步。
 */
export function lerpSignatureTowards(current, target, rate) {
  const clampedRate = Math.min(1, Math.max(0, rate))
  const lerp = (a, b) => a + (b - a) * clampedRate
  return {
    ...current,
    frequency: lerp(current.frequency, target.frequency),
    amplitude: lerp(current.amplitude, target.amplitude),
    waveHeight: lerp(current.waveHeight, target.waveHeight),
    waveformShape: lerp(current.waveformShape, target.waveformShape),
    hue: lerp(current.hue, target.hue),
    colorIntensity: lerp(
      current.colorIntensity ?? BASE_COLOR_INTENSITY,
      target.colorIntensity ?? BASE_COLOR_INTENSITY,
    ),
  }
}

/**
 * 把多位 agent 的波形簽章平均成一個共同的基準簽章。手機這邊理論上不需要
 * 自己呼叫這個函式（融合波形已經由桌機展示端算好、透過
 * POST /api/onboarding-sessions/{id}/result 存進後端），這裡保留只是為了
 * 跟桌機端維持同一份工具程式碼、方便之後萬一要在手機端自行重算時直接可用。
 */
export function mergeWaveformSignatures(signatures) {
  const list = (signatures || []).filter(Boolean)
  if (list.length === 0) {
    return {
      presetName: '融合',
      frequency: 1.2,
      amplitude: 0.3,
      waveHeight: 0.75,
      waveformShape: 0.3,
      hue: 200,
      colorIntensity: BASE_COLOR_INTENSITY,
    }
  }

  const avg = (key, fallback = 0) =>
    list.reduce((sum, s) => sum + (s[key] ?? fallback), 0) / list.length

  let sinSum = 0
  let cosSum = 0
  list.forEach((s) => {
    const rad = ((s.hue ?? 0) * Math.PI) / 180
    sinSum += Math.sin(rad)
    cosSum += Math.cos(rad)
  })
  const avgHueRad = Math.atan2(sinSum / list.length, cosSum / list.length)
  const avgHue = (Math.round((avgHueRad * 180) / Math.PI) + 360) % 360

  return {
    presetName: '融合',
    frequency: clamp(avg('frequency'), ...BOUNDS.frequency),
    amplitude: clamp(avg('amplitude'), ...BOUNDS.amplitude),
    waveHeight: clamp(avg('waveHeight'), ...BOUNDS.waveHeight),
    waveformShape: clamp(avg('waveformShape'), ...BOUNDS.waveformShape),
    hue: avgHue,
    colorIntensity: clamp(avg('colorIntensity', BASE_COLOR_INTENSITY), ...BOUNDS.colorIntensity),
  }
}

export const WAVEFORM_PRESETS = PRESETS
