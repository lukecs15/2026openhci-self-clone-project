/**
 * report.js — 三情境體驗的最終報告聚合
 *
 * 把三場辯論的紀錄（DebateStage 的 record）組成後端 OnboardingResult
 * （含新增的 scenarios 欄位，見 voice_clone_backend/models/schemas.py），
 * POST /result 後手機掃第二個 QR 就能取回（take away）。
 */

/** 融合波形：把兩位（或多位）agent 的 waveform_signature 平均成一顆。 */
export function mergeWaveformSignatures(signatures) {
  const valid = (signatures || []).filter(Boolean)
  if (valid.length === 0) return null
  const avg = (key, fallback) =>
    valid.reduce((sum, s) => sum + Number(s[key] ?? fallback), 0) / valid.length
  // hue 用向量平均（避免 350 與 10 平均成 180 的跨圈錯誤）
  let x = 0
  let y = 0
  for (const s of valid) {
    const rad = ((Number(s.hue) || 0) * Math.PI) / 180
    x += Math.cos(rad)
    y += Math.sin(rad)
  }
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  return {
    presetName: '融合',
    frequency: avg('frequency', 1.2),
    amplitude: avg('amplitude', 0.3),
    waveHeight: avg('waveHeight', 0.75),
    waveformShape: avg('waveformShape', 0.3),
    hue,
    colorIntensity: avg('colorIntensity', 0.55),
  }
}

/** 從 verdict 萃取「介入思考變化」摘要文字（judge_interventions 聚合）。 */
function interventionReflection(verdict, interventions) {
  const fromVerdict = Array.isArray(verdict?.judge_interventions)
    ? verdict.judge_interventions.filter(Boolean)
    : []
  if (fromVerdict.length > 0) return fromVerdict.join('；')
  if ((interventions || []).length > 0) return `你在討論中親口說出了 ${interventions.length} 次想法。`
  return '這個情境你選擇靜靜聽完兩個自己的對話。'
}

/**
 * @param {Array} records DebateStage onComplete 收集的三筆紀錄（依情境順序）
 * @param {object} session 後端 OnboardingSession（取融合波形素材）
 * @returns {object} OnboardingResult payload（POST /result 的 body）
 */
export function buildResultPayload(records, session) {
  const scenarios = records.map((r) => ({
    scenario_id: r.scenarioId,
    title: r.title,
    question: r.question,
    choice_side: r.choiceSide || '',
    choice_label: r.choiceLabel || '',
    stance_a: r.stanceA?.label || '',
    stance_b: r.stanceB?.label || '',
    summary:
      r.verdict?.final_verdict ||
      r.verdict?.case_title ||
      r.summaryText ||
      '兩個你來回交換了對這個處境的看法。',
    interventions: r.interventions || [],
    intervention_reflection: interventionReflection(r.verdict, r.interventions),
    verdict: r.verdict || null,
  }))

  const last = records[records.length - 1]
  const summaryText =
    last?.verdict?.closing_line || last?.summaryText || '三個情境走完，你更靠近自己一點了。'

  const agentSignatures = (session?.agents || []).map((a) => a.waveform_signature)

  return {
    summary_text: summaryText,
    verdict: last?.verdict || null,
    topic_title: '三情境內在對話體驗',
    waveform_signature: mergeWaveformSignatures(agentSignatures),
    participant_agents: records.flatMap((r) => [
      { agent_id: `${r.scenarioId}_stance_a`, display_name: r.stanceA?.stanceName || '', role_tag: r.stanceA?.label || '' },
      { agent_id: `${r.scenarioId}_stance_b`, display_name: r.stanceB?.stanceName || '', role_tag: r.stanceB?.label || '' },
    ]),
    scenarios,
  }
}
