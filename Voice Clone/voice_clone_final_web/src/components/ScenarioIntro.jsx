/**
 * ScenarioIntro.jsx — 情境導入頁（短片 + 文字描述，讓使用者進入情境）
 *
 * 對應整體流程第 3 步。素材來自 data/scenarios.js，優先序：
 *   video（scenario-N.mp4，自動播放/循環/靜音）→ image（scenario-N.jpg）
 *   → fallbackImage（佔位 SVG）
 * 影片載入失敗（檔案還沒放）自動退回圖片，補素材不需要改程式。
 * 影片在這裡播過一次後進入瀏覽器快取，辯論頁的背景影片會直接命中。
 */

import { useEffect, useState } from 'react'
import BgWash from './BgWash'

export default function ScenarioIntro({ scenario, onEnter }) {
  const [videoOk, setVideoOk] = useState(!!scenario.video)
  const [imgSrc, setImgSrc] = useState(scenario.image)

  // 切換情境時重置素材狀態（避免上一個情境的 fallback 殘留）
  useEffect(() => {
    setVideoOk(!!scenario.video)
    setImgSrc(scenario.image)
  }, [scenario.id, scenario.video, scenario.image])

  return (
    <div className="intro">
      <BgWash />
      <div className="stageKicker">情境 {scenario.order} / 3</div>
      <h2 className="introTitle">{scenario.title}</h2>
      <div className="introImageWrap">
        {videoOk ? (
          <video
            className="introVideo"
            src={scenario.video}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            onError={() => setVideoOk(false)}
          />
        ) : (
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
        )}
      </div>
      <p className="introDesc">{scenario.description}</p>
      <p className="introQuestion">{scenario.question}</p>
      <button type="button" className="btn btnPrimary" onClick={onEnter}>
        進入情境
      </button>
    </div>
  )
}
