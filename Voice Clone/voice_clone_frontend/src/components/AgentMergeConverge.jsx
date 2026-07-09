/**
 * AgentMergeConverge.jsx — 「各 agent 波形飛向中心再融合」的匯聚動畫
 *
 * 需求：結束對話／討論時，使用者希望有一個更有沉浸感、視覺品質更高的
 * 「Agent 波形融合」動畫，不是幾張方形卡片直線縮小消失（第一版做法，
 * 使用者實測回報「有點糟糕」）。這一版改成：
 *
 *   - 用發光的圓形「能量球」取代方形卡片：徹底移除方框邊界與陰影卡片感，
 *     改用 `radial-gradient` + `box-shadow` 營造柔和光暈，`mixBlendMode:
 *     'screen'` 讓每個球的光暈跟底下已經在播放的融合波形（見
 *     SessionSummaryScreen.jsx）用加法混色疊在一起，感覺像同一個光源
 *     系統的一部分，而不是浮在上面的不透明 UI 元素。
 *   - 球心疊一小段用 `utils/waveformPath.js` 的 `buildWavePath()` 算出的
 *     靜態波形線條（該 agent自己的簽章），保留「這是一個波形」的視覺
 *     識別，同時避免在每個球裡都跑一份完整的 WaveformAvatar 動畫迴圈
 *     （只需要算一次靜態 path，沒有額外的 requestAnimationFrame 負擔）。
 *   - 移動路徑不是直線：用 CSS `@keyframes` 搭配一個「中繼點」（把起點
 *     繞著中心旋轉一個固定角度、往內收），讓所有球一起朝同一個方向
 *     旋轉內縮，形成類似漩渦被吸入中心的動態，比「每個球各自沿直線走
 *     向中心」有更強的整體感與流動感。
 *   - 每個 agent 除了「本體」球，額外疊 2 顆更小、更透明、更模糊的
 *     「殘影」球（沿用同一條路徑、只是起跑時間稍微晚一點點），營造柔和
 *     的拖尾光跡，加強「能量流動」的沉浸感。
 *   - 收斂完成的瞬間，畫面中心會有一個短暫的白色光暈「綻放」
 *     （`agentMergeBurst`），呼應「所有波形真的融合在一起了」的敘事高潮，
 *     而不是球體悄悄消失、什麼反應都沒有。
 *
 * ── 設計取捨 ──────────────────────────────────────────────────────────
 * 沒有做「真的從對話畫面裡每個 agent 方框當時的實際像素位置飛過來」的
 * FLIP 動畫：結束畫面是獨立掛載的全螢幕 overlay，掛載時原本的
 * AgentStage 方框已經卸載，量測不到「上一刻」的真實位置，硬做容易對不
 * 準、感覺卡卡的。改用「環狀分布、集體同向旋轉內縮」的版本，敘事意圖
 * 一樣成立（各自的能量匯聚成一個），實作複雜度也低很多。
 *
 * ── 時間軸 ────────────────────────────────────────────────────────────
 * 這一版改用 CSS `@keyframes` 動畫（而不是 `transition`）：`animation`
 * 屬性一旦掛上就會自動從 `0%` 關鍵影格開始播放，不需要像 CSS transition
 * 那樣先掛載「初始樣式」、下一幀才切換成「目標樣式」的雙緩衝手法
 * （`animation-fill-mode: both` 會讓 `animation-delay` 期間也維持在
 * `0%` 關鍵影格的樣子，不會有一閃而過的「原始未設定樣式」畫面）。每個
 * agent 依索引錯開一點點出發時間（`STAGGER_MS`），最後一個 agent 的
 * 動畫播完（含 stagger 延遲與一點緩衝時間）才呼叫 `onComplete`，讓呼叫端
 * （SessionSummaryScreen.jsx）接著開始總結文字的淡入——「波形匯聚」跟
 * 「文字浮現」刻意不重疊，是兩個清楚分開、依序發生的動作。
 *
 * 尊重 `prefers-reduced-motion`：呼叫端在使用者開啟「減少動態效果」
 * 系統設定時，會直接跳過這個元件、不觸發匯聚動畫，避免造成不適。
 */

import { useEffect } from 'react'
import { getWaveformSignature } from '../utils/waveformSignature'
import { buildWavePath } from '../utils/waveformPath'
import { buildWaveformColors } from '../utils/waveformColor'

// 環的橢圓半徑（vw/vh 單位，天生 responsive，不需要 ResizeObserver）。
// 橢圓（而不是正圓）比較貼合螢幕通常是橫向的比例，球體不會太靠近上下邊緣。
const RING_RADIUS_X_VW = 30
const RING_RADIUS_Y_VH = 22

// 中繼點：把起點繞中心旋轉這個角度、往內收到這個比例，所有 agent 都往
// 同一個方向轉，營造「集體被吸入漩渦中心」的旋轉內縮動態。
const SWIRL_ANGLE_DEG = 42
const SWIRL_INWARD_RATIO = 0.52

const ORB_SIZE_PX = 'clamp(56px, 8vw, 96px)'
const GLOW_PX = 34

const CONVERGE_DURATION_MS = 1700
const STAGGER_MS = 110
// onComplete 額外緩衝，確保連 stagger 最晚出發的那一個也真的播完。
const COMPLETE_BUFFER_MS = 250

const BURST_DURATION_MS = 650
// 綻放光暈提前一點點出現，讓它在最後一顆球消失的瞬間達到最亮，感覺像
// 「球體收斂的能量轉換成這道閃光」，而不是球先消失、閃光才慢半拍出現。
const BURST_LEAD_MS = 320

// 每個 agent 除了本體，額外疊幾顆更小更透明更模糊的殘影，沿同一條路徑
// 稍微晚一點出發，形成柔和拖尾。
const ECHO_LAYERS = [
  { key: 'core', sizeScale: 1, opacityScale: 1, blurPx: 0, extraDelayMs: 0, showSquiggle: true },
  { key: 'echo-1', sizeScale: 0.8, opacityScale: 0.38, blurPx: 3, extraDelayMs: 70, showSquiggle: false },
  { key: 'echo-2', sizeScale: 0.6, opacityScale: 0.18, blurPx: 6, extraDelayMs: 140, showSquiggle: false },
]

const MINI_WAVE_WIDTH = 80
const MINI_WAVE_HEIGHT = 34

function rotatePoint(x, y, deg) {
  const rad = (deg * Math.PI) / 180
  return [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)]
}

export default function AgentMergeConverge({ agents, onComplete }) {
  const list = agents || []
  const count = list.length

  useEffect(() => {
    if (count === 0) {
      // 沒有 agent 可以匯聚（理論上不會發生），直接跳過動畫。
      onComplete?.()
      return undefined
    }
    const lastArrivalMs = CONVERGE_DURATION_MS + (count - 1) * STAGGER_MS
    const timeout = setTimeout(() => onComplete?.(), lastArrivalMs + COMPLETE_BUFFER_MS)
    return () => clearTimeout(timeout)
    // 只需要在掛載時排一次；agents 在結束畫面顯示期間不會變動。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (count === 0) return null

  const lastArrivalMs = CONVERGE_DURATION_MS + (count - 1) * STAGGER_MS
  const burstDelayMs = Math.max(0, lastArrivalMs - BURST_LEAD_MS)

  return (
    <div
      style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', overflow: 'hidden' }}
      aria-hidden="true"
    >
      {/* 共用的 @keyframes 定義，所有球體／殘影／綻放光暈都靠 CSS 自訂
          屬性（--start-x 等）帶入各自不同的數值，只需要定義一次。 */}
      <style>{`
        @keyframes agentMergeConverge {
          0% {
            transform: translate(-50%, -50%) translate(var(--start-x), var(--start-y)) scale(1);
            opacity: 0.95;
          }
          55% {
            transform: translate(-50%, -50%) translate(var(--mid-x), var(--mid-y)) scale(0.7);
            opacity: 0.88;
          }
          100% {
            transform: translate(-50%, -50%) translate(0, 0) scale(0.04);
            opacity: 0;
          }
        }
        @keyframes agentMergeBurst {
          0% { transform: translate(-50%, -50%) scale(0.15); opacity: 0.9; }
          60% { opacity: 0.55; }
          100% { transform: translate(-50%, -50%) scale(1); opacity: 0; }
        }
      `}</style>

      {list.map((agent, i) => {
        const signature = getWaveformSignature(agent)
        const colors = buildWaveformColors({ hue: signature.hue, colorIntensity: signature.colorIntensity })
        const miniWaveD = buildWavePath({
          signature,
          time: 0.6,
          speakIntensity: 0.55,
          width: MINI_WAVE_WIDTH,
          height: MINI_WAVE_HEIGHT,
          points: 28,
        })

        const angle = (-90 + (360 / count) * i) * (Math.PI / 180)
        const startX = Math.cos(angle) * RING_RADIUS_X_VW
        const startY = Math.sin(angle) * RING_RADIUS_Y_VH
        const [midXRaw, midYRaw] = rotatePoint(startX, startY, SWIRL_ANGLE_DEG)
        const midX = midXRaw * SWIRL_INWARD_RATIO
        const midY = midYRaw * SWIRL_INWARD_RATIO
        const baseDelayMs = i * STAGGER_MS

        return (
          <div key={agent.agent_id || agent.display_name || i}>
            {ECHO_LAYERS.map((echo) => (
              <div
                key={echo.key}
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  width: `calc(${ORB_SIZE_PX} * ${echo.sizeScale})`,
                  height: `calc(${ORB_SIZE_PX} * ${echo.sizeScale})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  borderRadius: '50%',
                  mixBlendMode: 'screen',
                  background: `radial-gradient(circle at 35% 32%, hsla(${signature.hue}, 95%, 80%, ${0.95 * echo.opacityScale}) 0%, hsla(${signature.hue}, 90%, 60%, ${0.55 * echo.opacityScale}) 42%, hsla(${signature.hue}, 85%, 45%, 0) 72%)`,
                  boxShadow: `0 0 ${GLOW_PX}px hsla(${signature.hue}, 90%, 60%, ${0.5 * echo.opacityScale})`,
                  filter: echo.blurPx ? `blur(${echo.blurPx}px)` : undefined,
                  '--start-x': `${startX}vw`,
                  '--start-y': `${startY}vh`,
                  '--mid-x': `${midX}vw`,
                  '--mid-y': `${midY}vh`,
                  animation: `agentMergeConverge ${CONVERGE_DURATION_MS}ms cubic-bezier(0.65, 0, 0.35, 1) ${baseDelayMs + echo.extraDelayMs}ms 1 both`,
                }}
              >
                {echo.showSquiggle && (
                  <svg
                    viewBox={`0 0 ${MINI_WAVE_WIDTH} ${MINI_WAVE_HEIGHT}`}
                    style={{ width: '68%', height: '46%' }}
                  >
                    <path
                      d={miniWaveD}
                      fill="none"
                      stroke={colors.glow}
                      strokeOpacity="0.9"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </div>
            ))}
          </div>
        )
      })}

      {/* 收斂完成瞬間的白色光暈綻放，見檔案開頭說明。 */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: 'min(64vw, 64vh)',
          height: 'min(64vw, 64vh)',
          borderRadius: '50%',
          mixBlendMode: 'screen',
          background:
            'radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.35) 32%, rgba(255,255,255,0) 68%)',
          animation: `agentMergeBurst ${BURST_DURATION_MS}ms ease-out ${burstDelayMs}ms 1 both`,
        }}
      />
    </div>
  )
}
