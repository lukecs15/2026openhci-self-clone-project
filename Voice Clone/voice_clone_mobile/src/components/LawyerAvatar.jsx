/**
 * LawyerAvatar.jsx — 審訊畫面的律師/法官 SVG 頭像（逐字移植設計稿的 SVG 標記）
 *
 * 對應設計稿 inner-court-survey-fix8.html 的 <svg id="lawyer">（見該檔案
 * 「═══ 2|審訊 ═══」段落）：頭部由「點弧髮際 + 五條 OCEAN 色波紋(臉) + 串珠
 * 下顎」組成、圓眼鏡、法袍、白色律師領帶、手持案卷、五色徽章。
 *
 * 反應動畫用「單一事件物件 + key remount」的方式觸發，不是照搬設計稿原本
 * `classList.remove(...); void el.offsetWidth; classList.add(...)` 的強制
 * reflow手法——那個手法是命令式 DOM 操作常見的「讓同一個 class 可以重複
 * 觸發 CSS animation」技巧，在 React 裡用 key 變化強制整個子樹 remount 是
 * 更符合 React 慣例、也更不容易出錯的等效做法（副作用：連帶重置頭像本身
 * 「呼吸」bob 動畫的相位、眨眼計時器，視覺上幾乎看不出來，可接受）。
 *
 * @param {{ seq: number, kind: 'answer'|'tap'|null, value?: number }} props.event
 *   seq 每次事件遞增（當 remount key）；kind 決定要套用哪組反應 class；
 *   kind==='answer' 時依 value（1~5，使用者剛點的原始 Likert 值，不是反向
 *   計分後的分數——這跟設計稿行為一致，見該檔案 answer() 函式）決定
 *   deepnod(>=5)／shake(<=2)／一般 nod(其餘)。kind==='tap' 觸發 hop。
 * @param {() => void} props.onTap 點擊頭像時呼叫（父層負責顯示小語泡泡）
 */
import { useEffect, useRef } from 'react'

export default function LawyerAvatar({ event, onTap }) {
  const eyesRef = useRef(null)

  useEffect(() => {
    const blink = setInterval(() => {
      const eyes = eyesRef.current
      if (!eyes) return
      eyes.style.transform = 'scaleY(0.1)'
      eyes.style.transformOrigin = '46px 33px'
      setTimeout(() => {
        if (eyes) eyes.style.transform = ''
      }, 130)
    }, 3400)
    return () => clearInterval(blink)
  }, [])

  const headClass = event.kind === 'answer' ? (event.value >= 5 ? 'deepnod' : event.value <= 2 ? 'shake' : '') : ''
  const wrapperClass = event.kind === 'answer' && !headClass ? 'nod' : event.kind === 'tap' ? 'hop' : ''
  const docClass = event.kind === 'answer' ? 'write' : ''

  return (
    <div className="lawyerWrap" onClick={onTap}>
      <svg
        className={`lawyer ${wrapperClass}`}
        viewBox="0 0 92 130"
        fill="none"
        stroke="rgba(24,28,38,.85)"
        strokeWidth="1.6"
        strokeLinecap="round"
      >
        <g>
          <g className={`headGroup ${headClass}`}>
            <g fill="rgba(24,28,38,.9)" stroke="none">
              <circle cx="29.0" cy="20.5" r="1.15" />
              <circle cx="32.4" cy="18.5" r="0.95" />
              <circle cx="35.8" cy="16.7" r="1.15" />
              <circle cx="39.2" cy="15.2" r="0.95" />
              <circle cx="42.6" cy="14.3" r="1.15" />
              <circle cx="46.0" cy="14.0" r="0.95" />
              <circle cx="49.4" cy="14.3" r="1.15" />
              <circle cx="52.8" cy="15.2" r="0.95" />
              <circle cx="56.2" cy="16.7" r="1.15" />
              <circle cx="59.6" cy="18.5" r="0.95" />
              <circle cx="63.0" cy="20.5" r="1.15" />
            </g>
            <circle cx="27" cy="21" r="1.9" stroke="rgba(24,28,38,.85)" strokeWidth="1.7" />
            <circle cx="65" cy="21" r="1.9" stroke="rgba(24,28,38,.85)" strokeWidth="1.7" />
            <g fill="none" strokeWidth="1.1" strokeLinecap="round">
              <path d="M30,25 q4,-1.6 8,0 t8,0 t8,0 t8,0" stroke="var(--O)" />
              <path d="M30,29 q4,-0.9 8,0 t8,0 t8,0 t8,0" stroke="var(--C)" />
              <path d="M30,33 q4,-2.4 8,0 t8,0 t8,0 t8,0" stroke="var(--E)" />
              <path d="M30,37.5 q4,-1.4 8,0 t8,0 t8,0 t8,0" stroke="var(--A)" />
              <path d="M30,42 l3.6,-1.8 3.6,1.8 3.6,-1.8 3.6,1.8 3.6,-1.8 3.6,1.8 3.6,-1.8 3.6,1.8" stroke="var(--N)" />
            </g>
            <g fill="rgba(24,28,38,.9)" stroke="none">
              <circle cx="31.0" cy="45.5" r="1.3" />
              <circle cx="34.8" cy="46.3" r="1.0" />
              <circle cx="38.5" cy="47.1" r="1.3" />
              <circle cx="42.2" cy="47.5" r="1.0" />
              <circle cx="46.0" cy="47.7" r="1.3" />
              <circle cx="49.8" cy="47.5" r="1.0" />
              <circle cx="53.5" cy="47.1" r="1.3" />
              <circle cx="57.2" cy="46.3" r="1.0" />
              <circle cx="61.0" cy="45.5" r="1.3" />
            </g>
            <circle cx="39" cy="33" r="4.8" fill="rgba(255,255,255,.65)" />
            <circle cx="53" cy="33" r="4.8" fill="rgba(255,255,255,.65)" />
            <line x1="43.8" y1="33" x2="48.2" y2="33" />
            <line x1="34.2" y1="33" x2="29.5" y2="31.4" />
            <line x1="57.8" y1="33" x2="62.5" y2="31.4" />
            <g ref={eyesRef}>
              <circle cx="39" cy="33" r="1.15" fill="rgba(24,28,38,.9)" stroke="none" />
              <circle cx="53" cy="33" r="1.15" fill="rgba(24,28,38,.9)" stroke="none" />
            </g>
          </g>
          <path d="M28 122 C26 84 32 62 46 56 C60 62 66 84 64 122" />
          <path d="M42 56 L41 72 L45 68 Z" fill="#fff" stroke="rgba(24,28,38,.6)" strokeWidth="0.8" />
          <path d="M50 56 L51 72 L47 68 Z" fill="#fff" stroke="rgba(24,28,38,.6)" strokeWidth="0.8" />
          <g className={`docGroup ${docClass}`}>
            <rect x="55" y="86" width="20" height="26" rx="2" transform="rotate(8 65 99)" />
            <line x1="59" y1="93" x2="71" y2="95" />
            <line x1="58.6" y1="98" x2="70.6" y2="100" />
          </g>
          <circle cx="35" cy="66" r="1.6" fill="var(--E)" stroke="none" />
          <circle cx="35" cy="71" r="1.6" fill="var(--A)" stroke="none" />
          <circle cx="35" cy="76" r="1.6" fill="var(--C)" stroke="none" />
          <circle cx="35" cy="81" r="1.6" fill="var(--N)" stroke="none" />
          <circle cx="35" cy="86" r="1.6" fill="var(--O)" stroke="none" />
        </g>
      </svg>
    </div>
  )
}
