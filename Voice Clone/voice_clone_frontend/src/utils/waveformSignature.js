/**
 * waveformSignature.js — 每位 agent 的「波形人格簽章」
 *
 * 需求：agent 頭像改用動態波形呈現，初始波形要能反映 agent 的背景設定，
 * 波形的視覺元素對照使用者提供的心理意義表格：
 *
 *   頻率（frequency）    → 思緒速度、焦慮程度、反覆出現的念頭
 *   振幅（amplitude）    → 情緒強度
 *   波高（waveHeight）   → 該角色在當下的主導程度
 *   波形（waveformShape）→ 說話方式、人格風格、反應模式
 *   顏色（hue）          → 生命階段、情緒類型或記憶溫度
 *
 * 真正「從 persona_prompt 文字分析出這五個參數」的部分，使用者確認之後會
 * 改成透過問卷讓使用者自己設定（而不是分析自由文字），所以這裡刻意先不做
 * 文字語意分析，只提供一組**決定性的預設值**：用 agent_id 雜湊挑選一個
 * 預先設計好的「波形人格」原型（PRESETS，每一個原型本身就是依照上面的
 * 心理意義表格刻意調過的一組參數，不是隨機亂數），並加一點依 agent_id
 * 產生的小幅 jitter，讓即使兩個 agent 選到同一個原型，視覺上也會有些微
 * 差異。同一個 agent_id 每次呼叫一定得到完全相同的結果（純函式、無外部
 * 狀態），重整頁面或换分頁都不會讓頭像「跳掉」。
 *
 * ── 接線點：之後問卷流程 ──────────────────────────────────────────────
 * 之後如果 agent 物件（AgentConfig）上帶有 `waveform_signature` 欄位
 * （結構跟這裡回傳的物件一樣：{ frequency, amplitude, waveHeight,
 * waveformShape, hue }，來源是使用者填問卷後算出來的真實數值），這個函式
 * 會直接優先採用該欄位、完全略過 preset 挑選邏輯——呼叫端（WaveformAvatar
 * / AgentStage）不需要跟著改，只要 agent 物件多了這個欄位就會自動生效。
 *
 * ── 情緒訊號 ────────────────────────────────────────────────────────
 * 這裡的簽章只代表「角色一直以來大致是什麼樣子」的基準波形；對話過程中
 * 每一輪話語的情緒起伏是另外一層（見 utils/emotionSignal.js 的
 * analyzeTurnEmotion()），用 applyEmotionSignal() 疊加在基準簽章上，
 * 兩者刻意分開設計，職責不同。
 */

// 六個預先設計好的「波形人格」原型，每一項的五個參數都是刻意依照上方
// 心理意義表格挑的（不是隨機生成），數值範圍見各欄位的 clamp 邊界。
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

/** 邊界，避免 preset * (1 + jitter) 後跑出視覺上不合理的範圍。 */
const BOUNDS = {
  frequency: [0.4, 3.0],
  amplitude: [0.1, 0.6],
  waveHeight: [0.4, 1.0],
  waveformShape: [0, 1],
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 簡單、決定性的字串雜湊（32-bit FNV-1a 變體）。不需要密碼學等級的雜湊，
 * 只需要「同樣字串一定得到同樣數字、不同字串大機率得到不同數字」。
 */
function hashString(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // 轉成非負整數
  return hash >>> 0
}

/** 依 seed 字串算出一個 -1..1 之間的決定性小數，用來當 jitter 幅度。 */
function jitterFactor(seed) {
  const h = hashString(seed)
  return ((h % 2001) - 1000) / 1000 // -1..1
}

/**
 * 取得某個 agent 的波形簽章。純函式：同樣的 agent 物件（同 agent_id）
 * 永遠回傳同一組數值。
 *
 * @param {{ agent_id?: string, display_name?: string, waveform_signature?: object }} agent
 * @returns {{ presetName: string, frequency: number, amplitude: number, waveHeight: number, waveformShape: number, hue: number }}
 */
export function getWaveformSignature(agent) {
  if (agent && agent.waveform_signature) {
    // 見檔案開頭「接線點」說明：問卷流程算好的真實數值直接優先採用。
    return agent.waveform_signature
  }

  const key = (agent && (agent.agent_id || agent.display_name)) || 'default-agent'
  const seed = hashString(key)
  const preset = PRESETS[seed % PRESETS.length]

  // 每個維度用不同的 jitter seed（避免五個維度的 jitter 彼此完全相關）。
  const freqJitter = jitterFactor(`${key}:frequency`) * 0.15
  const ampJitter = jitterFactor(`${key}:amplitude`) * 0.15
  const heightJitter = jitterFactor(`${key}:waveHeight`) * 0.12
  const shapeJitter = jitterFactor(`${key}:waveformShape`) * 0.2
  const hueJitter = jitterFactor(`${key}:hue`) * 20 // ±20 度色相微調

  return {
    presetName: preset.name,
    frequency: clamp(preset.frequency * (1 + freqJitter), ...BOUNDS.frequency),
    amplitude: clamp(preset.amplitude * (1 + ampJitter), ...BOUNDS.amplitude),
    waveHeight: clamp(preset.waveHeight * (1 + heightJitter), ...BOUNDS.waveHeight),
    waveformShape: clamp(preset.waveformShape + shapeJitter, ...BOUNDS.waveformShape),
    hue: (Math.round(preset.hue + hueJitter) + 360) % 360,
  }
}

/**
 * 把單輪情緒訊號（見 utils/emotionSignal.js 的 analyzeTurnEmotion()）疊加
 * 在角色的基準波形簽章上，回傳一組新的（clamp 過的）簽章。刻意不改動
 * `waveHeight`：波高代表「主導程度」，是角色一直以來的特質，不應該因為
 * 單輪情緒起伏而改變，只有頻率/振幅/波形/顏色會隨情緒微調——這樣「以角色
 * 波形為主軸，情緒只是讓它有感地變化」的設計意圖才成立。
 *
 * @param {{frequency:number, amplitude:number, waveHeight:number, waveformShape:number, hue:number}} baseSignature
 * @param {{frequencyDelta?:number, amplitudeDelta?:number, shapeDelta?:number, hueDelta?:number}} [emotion]
 */
export function applyEmotionSignal(baseSignature, emotion) {
  if (!emotion) return baseSignature
  return {
    ...baseSignature,
    frequency: clamp(baseSignature.frequency + (emotion.frequencyDelta || 0), ...BOUNDS.frequency),
    amplitude: clamp(baseSignature.amplitude + (emotion.amplitudeDelta || 0), ...BOUNDS.amplitude),
    waveformShape: clamp(baseSignature.waveformShape + (emotion.shapeDelta || 0), ...BOUNDS.waveformShape),
    hue: (Math.round(baseSignature.hue + (emotion.hueDelta || 0)) + 360) % 360,
  }
}

/**
 * 逐欄位把目前的波形簽章平滑地往目標簽章移動一小步，用來讓 WaveformAvatar
 * 在情緒訊號變化時（例如換了一句新的話）波形是漸變過去，不是瞬間跳一下。
 * 跟 utils/waveformPath.js 的 lerpTowards() 是同一種線性插值，只是這裡
 * 一次對整組簽章的每個欄位做。
 *
 * 已知的小簡化：`hue` 用直線插值、沒有處理「跨過 0/360 邊界該走最短路徑」
 * 的情況（例如從 350 度插值到 10 度，理論上最短路徑是 +20 度，這裡會算成
 * -340 度方向繞一大圈）。目前情緒造成的色相偏移量不大（見 emotionSignal.js
 * 的 hueDelta 範圍），實務上不太會真的跨越邊界，先不處理這個邊界情況。
 *
 * @param {object} current
 * @param {object} target
 * @param {number} rate 0～1，每次呼叫要往目標移動的比例
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
  }
}

/** 匯出供測試/未來擴充使用（例如問卷介面想提供「參考現有原型」的選單）。 */
export const WAVEFORM_PRESETS = PRESETS
