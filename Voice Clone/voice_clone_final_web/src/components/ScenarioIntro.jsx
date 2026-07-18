/**
 * ScenarioIntro.jsx — 情境導入頁（圖片 + 文字描述，讓使用者進入情境）
 *
 * 對應整體流程第 3 步。圖片與文案來自 data/scenarios.js。
 * 圖片載入策略：先載正式圖（scenario.image，例如 scenario-1.jpg），
 * 檔案還沒放（404）時 onError 自動退回佔位 SVG（scenario.fallbackImage），
 * 之後補上正式圖片不需要改任何程式碼。
 */

import { useEffect, useState } from 'react'

export default function ScenarioIntro({ scenario, onEnter }) {
  const [imgSrc, setImgSrc] = useState(scenario.image)

  // 切換情境時重置回正式圖路徑（避免上一個情境 fallback 狀態殘留）
  useEffect(() => {
    setImgSrc(scenario.image)
  }, [scenario.id, scenario.image])

  return (
    <div className="intro">
      <div className="stageKicker">情境 {scenario.order} / 3</div>
      <h2 className="introTitle">{scenario.title}</h2>
      <div className="introImageWrap">
        <img
          src={imgSrc}
          alt={scenario.title}
          className="introImage"
          onError={() => {
            if (scenario.fallbackImage && imgSrc !== scenario.fallbackImage) {
              setImgSrc(scenario.fallbackImage)
            }
          }}
        />
      </div>
      <p className="introDesc">{scenario.description}</p>
      <p className="introQuestion">{scenario.question}</p>
      <p className="introHint">先別急著回答——先聽聽兩個「你」怎麼說。</p>
      <button type="button" className="btn btnPrimary" onClick={onEnter}>
        進入情境
      </button>
    </div>
  )
}
