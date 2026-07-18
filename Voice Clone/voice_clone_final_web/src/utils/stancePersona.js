/**
 * stancePersona.js — 依情境選項組出兩個「立場克隆自我」的 AgentConfig
 *
 * 設計（依專案需求確認）：兩個立場 agent 不是從後端 5 位自我中挑選，而是
 * 「純立場」persona——以下三份材料一起餵進 persona_prompt：
 *   1. Big Five 五向度分數的人格摘要（讓立場說話帶著使用者的人格底色）
 *   2. 使用者在手機端最後一題親口說的「觀念問題」回答逐字稿
 *      （voice_reference_text，人際關係 vs 個人責任的價值傾向），
 *      讓兩個立場能真的引用、呼應、挑戰使用者自己說過的話
 *   3. 情境選項的立場主張（scenarios.js 的 stancePrompt）
 *
 * 兩個 agent 共用同一個 voice_profile_id（同一顆克隆聲音——都是「你」），
 * waveform_signature 帶入該立場的 hue 與依 Big Five 微調的參數，讓後端
 * 生成與前端渲染（LineOrbs）有一致的視覺識別。
 */

const TRAIT_LABELS = [
  ['openness', '開放性'],
  ['conscientiousness', '盡責性'],
  ['extraversion', '外向性'],
  ['agreeableness', '親和性'],
  ['neuroticism', '負向情緒'],
]

function band(score) {
  if (score >= 65) return '偏高'
  if (score <= 35) return '偏低'
  return '中等'
}

/** Big Five 分數 → 一句可讀的人格摘要（餵給 persona_prompt 用）。 */
export function describeBigFive(scores = {}) {
  return TRAIT_LABELS.map(([key, label]) => {
    const v = Math.round(Number(scores[key] ?? 50))
    return `${label} ${v}/100（${band(v)}）`
  }).join('、')
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * 依 Big Five 微調波形簽章參數（結構對照 utils/waveformSignature.js /
 * 後端 personality_mapping.py：frequency/amplitude/waveHeight/waveformShape/
 * hue/colorIntensity）。頻率跟著負向情緒（思緒速度/焦慮）、振幅跟著外向
 * （情緒能量）、波形跟著開放性（諧波複雜度），hue 由立場決定。
 */
function buildSignature(choice, scores = {}) {
  const n = Number(scores.neuroticism ?? 50) / 100
  const e = Number(scores.extraversion ?? 50) / 100
  const o = Number(scores.openness ?? 50) / 100
  return {
    frequency: lerp(0.7, 2.4, n),
    amplitude: lerp(0.18, 0.42, e),
    waveHeight: 0.75,
    waveformShape: lerp(0.1, 0.8, o),
    hue: choice.hue,
    colorIntensity: 0.55,
  }
}

function buildPersonaPrompt({ scenario, choice, otherChoice, bigFiveScores, valueText }) {
  const bigFiveLine = describeBigFive(bigFiveScores)
  const valueBlock = (valueText || '').trim()
    ? `【使用者親口說過的價值觀】使用者曾被問「當人際關係與個人責任發生時間衝突時，` +
      `你傾向配合他人還是堅持自我需求？」他親口回答：「${valueText.trim()}」。` +
      `你可以引用、呼應或挑戰這段他自己說過的話，讓討論貼近他真實的內心。\n`
    : ''
  return (
    `你是「${choice.stanceName}」——使用者內心的一個聲音，用使用者自己克隆的聲音說話，` +
    `所以你就是另一個「他自己」。\n` +
    `【使用者的人格底色（Big Five）】${bigFiveLine}。請讓你的語氣、用詞、思考方式` +
    `符合這樣的人格，像是這個人自己在腦中對自己說話。\n` +
    valueBlock +
    `【情境】${scenario.title}：${scenario.description}\n` +
    `【你的立場】你堅定主張「${choice.label}」。${choice.stancePrompt}\n` +
    `對面那個聲音（${otherChoice.stanceName}）主張「${otherChoice.label}」，你不認同。` +
    `請用第一人稱、口語、具體的方式說服對方與正在聆聽的使用者接受你的立場：` +
    `回應對方剛剛的論點、指出盲點，也誠實承認自己立場的代價，但說明為什麼仍然值得。` +
    `不要空泛說教，多用這個情境裡的具體細節。`
  )
}

/**
 * 組出這個情境的兩位立場 agent（恰好 2 位，第一位先開口）。
 *
 * @param {object} scenario data/scenarios.js 的一個情境
 * @param {object} session  後端 OnboardingSession（big_five_scores/
 *   voice_profile_id/voice_reference_text）
 * @returns {[AgentConfig, AgentConfig]}
 */
export function buildStanceAgents(scenario, session) {
  const bigFiveScores = session?.big_five_scores || {}
  const valueText = session?.voice_reference_text || ''
  const voiceProfileId = session?.voice_profile_id || ''

  const make = (side) => {
    const choice = scenario.choices[side]
    const otherChoice = scenario.choices[side === 'a' ? 'b' : 'a']
    return {
      agent_id: `${scenario.id}_stance_${side}`,
      display_name: choice.stanceName,
      persona_prompt: buildPersonaPrompt({ scenario, choice, otherChoice, bigFiveScores, valueText }),
      voice_profile_id: voiceProfileId,
      role_tag: choice.label,
      waveform_signature: buildSignature(choice, bigFiveScores),
    }
  }

  return [make('a'), make('b')]
}
