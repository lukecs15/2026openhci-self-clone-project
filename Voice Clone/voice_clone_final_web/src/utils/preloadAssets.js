/**
 * preloadAssets.js — 靜態資源預載
 *
 * 概念上對應 Django collectstatic 想解決的體驗問題：情境圖片如果等到
 * ScenarioIntro 掛載才開始下載，使用者會看到「先出現版面、圖片才慢半拍
 * 浮出來」。Vite 在 build 階段已經處理了資源的收集與雜湊（public/ 目錄
 * 原樣輸出），這裡補的是「提前下載」：App 一掛載（使用者還在掃 QR、
 * 填問卷的空檔）就把三個情境的正式圖與佔位圖全部拉進瀏覽器快取，
 * 進入情境頁時直接命中快取、零等待。
 *
 * 失敗無所謂：正式圖（scenario-N.jpg）還沒放時預載會 404，瀏覽器安靜
 * 忽略即可，ScenarioIntro 本來就有 onError fallback 機制。
 */

const preloaded = new Set()

function preloadImage(src) {
  if (!src || preloaded.has(src)) return
  preloaded.add(src)
  const img = new Image()
  img.decoding = 'async'
  img.src = src
}

/** 預載所有情境的圖片（正式圖 + 佔位 fallback）。冪等，重複呼叫不重下載。 */
export function preloadScenarioImages(scenarios) {
  for (const scenario of scenarios || []) {
    preloadImage(scenario.image)
    preloadImage(scenario.fallbackImage)
  }
}
