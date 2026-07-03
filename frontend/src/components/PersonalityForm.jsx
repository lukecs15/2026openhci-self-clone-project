/**
 * PersonalityForm.jsx - Big Five 人格問卷組件
 *
 * 功能：
 * - Big Five 簡版問卷（OCEAN，各維度 2 題，Likert 1–5 量表）
 * - 自由描述欄位（物品意義、自我描述）
 * - 送出後顯示人格摘要卡片
 * - 呼叫後端 /api/personality/analyze
 */

import { useState } from 'react'
import { analyzePersonality } from '../api/client'
import useAppStore from '../store/useAppStore'

const BIG_FIVE_QUESTIONS = [
  { key: 'openness_1', dimension: '開放性', label: '我喜歡嘗試新事物與新體驗' },
  { key: 'openness_2', dimension: '開放性', label: '我對藝術、音樂或文學有強烈的興趣' },
  { key: 'conscientiousness_1', dimension: '盡責性', label: '我做事有條理、計畫周詳' },
  { key: 'conscientiousness_2', dimension: '盡責性', label: '我能堅持完成困難的任務' },
  { key: 'extraversion_1', dimension: '外向性', label: '我喜歡與人交流、參加社交活動' },
  { key: 'extraversion_2', dimension: '外向性', label: '我在人群中能感到充滿活力' },
  { key: 'agreeableness_1', dimension: '親和性', label: '我容易同情他人的感受' },
  { key: 'agreeableness_2', dimension: '親和性', label: '我傾向於相信他人的善意' },
  { key: 'neuroticism_1', dimension: '神經質', label: '我容易感到焦慮或擔憂' },
  { key: 'neuroticism_2', dimension: '神經質', label: '我的情緒容易受到外界影響' },
]

const LIKERT_LABELS = ['', '非常不同意', '不同意', '普通', '同意', '非常同意']

const DIMENSION_COLORS = {
  '開放性': '#8b5cf6',
  '盡責性': '#06b6d4',
  '外向性': '#f59e0b',
  '親和性': '#10b981',
  '神經質': '#f43f5e',
}

function ScoreDot({ value }) {
  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <div key={n} style={{
          width: '10px', height: '10px', borderRadius: '50%',
          background: n <= value ? '#6366f1' : '#334155',
        }} />
      ))}
    </div>
  )
}

function PersonalitySummaryCard({ data }) {
  const { scores, personality_summary, communication_style, object_description } = data

  return (
    <div style={{
      background: '#1e293b',
      borderRadius: '12px',
      padding: '1.5rem',
      border: '1px solid #334155',
    }}>
      <h3 style={{ color: '#a5b4fc', marginBottom: '1rem', fontSize: '1rem' }}>✦ 你的物品人格</h3>

      <p style={{ color: '#e2e8f0', marginBottom: '0.5rem', fontSize: '0.875rem', fontStyle: 'italic' }}>
        「{object_description}」
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', margin: '1rem 0' }}>
        {Object.entries(scores).map(([key, val]) => {
          const labelMap = {
            openness: '開放性', conscientiousness: '盡責性',
            extraversion: '外向性', agreeableness: '親和性', neuroticism: '神經質',
          }
          const label = labelMap[key] || key
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: DIMENSION_COLORS[label] || '#94a3b8', fontSize: '0.75rem', minWidth: '3.5rem' }}>
                {label}
              </span>
              <ScoreDot value={Math.round(val)} />
              <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{val.toFixed(1)}</span>
            </div>
          )
        })}
      </div>

      <p style={{ color: '#cbd5e1', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: '0.75rem' }}>
        {personality_summary}
      </p>
      <p style={{ color: '#94a3b8', fontSize: '0.8rem', borderTop: '1px solid #334155', paddingTop: '0.75rem' }}>
        💬 溝通風格：{communication_style}
      </p>
    </div>
  )
}

export default function PersonalityForm({ onComplete }) {
  const setPersonality = useAppStore((s) => s.setPersonality)
  const setError = useAppStore((s) => s.setError)

  const [answers, setAnswers] = useState(
    Object.fromEntries(BIG_FIVE_QUESTIONS.map((q) => [q.key, 3]))
  )
  const [objectDescription, setObjectDescription] = useState('')
  const [selfDescription, setSelfDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  const handleLikert = (key, value) => {
    setAnswers((prev) => ({ ...prev, [key]: value }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!objectDescription.trim() || !selfDescription.trim()) {
      setError('請填寫物品描述與自我描述欄位。')
      return
    }

    setLoading(true)
    try {
      const payload = {
        big_five: answers,
        object_description: objectDescription,
        self_description: selfDescription,
      }
      const data = await analyzePersonality(payload)
      setPersonality(data)
      setResult(data)
      onComplete?.(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // 按維度分組題目
  const grouped = BIG_FIVE_QUESTIONS.reduce((acc, q) => {
    if (!acc[q.dimension]) acc[q.dimension] = []
    acc[q.dimension].push(q)
    return acc
  }, {})

  if (result) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PersonalitySummaryCard data={result} />
        <button
          onClick={() => setResult(null)}
          style={{
            alignSelf: 'flex-start',
            padding: '0.5rem 1rem',
            background: '#1e293b',
            color: '#94a3b8',
            border: '1px solid #334155',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          ← 重新填寫
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Big Five 問卷 */}
      {Object.entries(grouped).map(([dimension, questions]) => (
        <div key={dimension}>
          <h4 style={{
            color: DIMENSION_COLORS[dimension] || '#94a3b8',
            fontSize: '0.875rem',
            marginBottom: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            {dimension}
          </h4>
          {questions.map((q) => (
            <div key={q.key} style={{ marginBottom: '1rem' }}>
              <p style={{ color: '#cbd5e1', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{q.label}</p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => handleLikert(q.key, n)}
                    title={LIKERT_LABELS[n]}
                    style={{
                      width: '2.25rem',
                      height: '2.25rem',
                      borderRadius: '50%',
                      border: `2px solid ${answers[q.key] === n ? (DIMENSION_COLORS[dimension] || '#6366f1') : '#334155'}`,
                      background: answers[q.key] === n ? (DIMENSION_COLORS[dimension] || '#6366f1') : '#1e293b',
                      color: answers[q.key] === n ? '#fff' : '#64748b',
                      cursor: 'pointer',
                      fontWeight: 700,
                      fontSize: '0.875rem',
                      transition: 'all 0.15s',
                    }}
                  >
                    {n}
                  </button>
                ))}
                <span style={{ color: '#475569', fontSize: '0.75rem', alignSelf: 'center', marginLeft: '0.25rem' }}>
                  {LIKERT_LABELS[answers[q.key]]}
                </span>
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* 自由描述 */}
      <div>
        <label style={{ color: '#94a3b8', fontSize: '0.875rem', display: 'block', marginBottom: '0.5rem' }}>
          這個物品對你的意義 *
        </label>
        <textarea
          value={objectDescription}
          onChange={(e) => setObjectDescription(e.target.value)}
          placeholder="例如：這是我外婆送的茶杯，每次喝茶都會想起她的廚房..."
          rows={3}
          style={{
            width: '100%',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '8px',
            color: '#e2e8f0',
            padding: '0.75rem',
            fontSize: '0.875rem',
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </div>

      <div>
        <label style={{ color: '#94a3b8', fontSize: '0.875rem', display: 'block', marginBottom: '0.5rem' }}>
          請簡短描述你自己 *
        </label>
        <textarea
          value={selfDescription}
          onChange={(e) => setSelfDescription(e.target.value)}
          placeholder="例如：我是個容易思念過去的人，喜歡在深夜聽舊歌..."
          rows={3}
          style={{
            width: '100%',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '8px',
            color: '#e2e8f0',
            padding: '0.75rem',
            fontSize: '0.875rem',
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        style={{
          padding: '0.875rem 2rem',
          background: loading ? '#334155' : '#6366f1',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          fontSize: '1rem',
          fontWeight: 700,
          cursor: loading ? 'not-allowed' : 'pointer',
          alignSelf: 'flex-start',
          transition: 'background 0.2s',
        }}
      >
        {loading ? '分析中...' : '✦ 生成我的物品人格'}
      </button>
    </form>
  )
}
