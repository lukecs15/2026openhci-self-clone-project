# voice_clone_final_web — 三情境內在對話體驗（網頁版主系統）

> 展示端網頁：體驗者先在手機（`voice_clone_mobile`）完成 Big Five 問卷與聲音採集，
> 掃 QR 連結到這個網頁後，依序走過**三個情境**——每個情境由兩個「立場克隆自我」
> （使用者自己的克隆聲音）來回說服、辯論，體驗者有三次介入機會，最後做出選擇。
> 三個情境結束後生成聚合報告，掃第二個 QR 在手機領取（take away）。

## 體驗流程

```
connect  掃 QR（/link?session=<id>）→ 手機填問卷+錄音（最後一題=觀念問題）
         → 後端 status=linked → 顯示「五個自我甦醒」過場
intro    情境導入（圖片 + 文字，data/scenarios.js，目前為佔位圖）
debate   兩顆立場線條球（Line Orbs，附件波形設計移植）輪流發言
         ├─ 介入 ×3：按「介入討論」→ 立刻靜音+暫停 → 按住說話（後端 STT）
         │           或文字輸入 → 被打斷的立場接續回應
         └─ 達回合上限（VITE_DEBATE_MAX_TURNS）→ 做出選擇 → end_session
            → 後端生成該情境 verdict（判決書）
（intro/debate ×3）
report   三情境選擇、討論摘要、介入思考變化 → POST /result → 顯示領取 QR
```

## 低延遲/控時設計（網頁環境的關鍵）

Unity 版靠 PlayScheduled 精準控時；網頁版等價機制完整移植自
`voice_clone_frontend`（實測踩坑後的版本），兩者缺一不可：

1. **事件序列化管線**（`hooks/useDebateSession.js`）：所有
   `agent_speaking_*` 事件嚴格依序處理，chunk 音訊「真的播完」才處理下一個
   事件——字幕/波形高亮/聲音永遠對齊；暫停只需停掉當下一個音訊來源，
   epoch 機制讓管線中的舊事件全部作廢，不會冒出殘留內容。
2. **turn_played 真實回報**：`agent_speaking_end` 在管線中被處理到＝這輪
   真的播完，此時回報後端。後端「預生成下一輪」早已完成、扣在 buffer，
   收到回報立即放行——體感無縫接話，但後端永遠不超前使用者聽到的進度，
   介入打斷的一定是正在聽的那位。
3. 音訊是裸 16-bit PCM + sample_rate，手動建 AudioBuffer（不能走
   decodeAudioData）；播放鏈掛 AnalyserNode，把真實語音能量餵給 Line Orbs
   的「說話」視覺（核心顫動/聲納漣漪/主波抖動與實際聲音同步）。
4. 語音介入採 **16kHz mono WAV**（`utils/wavRecorder.js` 手工編碼，與
   Unity 版同格式），後端 soundfile 直讀、不走容器轉檔 fallback，STT 延遲最短。

## 立場 persona 的生成參考

`utils/stancePersona.js`：每情境兩位「純立場」agent（不挑後端 5 位自我），
persona_prompt 由三份材料組成——Big Five 分數摘要（人格底色）、使用者在
手機最後一題親口說的價值觀逐字稿（`voice_reference_text`，可被立場引用/
挑戰）、情境選項的立場主張（`data/scenarios.js` 的 `stancePrompt`）。
兩位共用同一個 `voice_profile_id`（都是「你」的聲音）。

## 換素材

三個情境的圖片/文案/立場全部在 `src/data/scenarios.js`；佔位圖在
`public/scenarios/*.svg`，換成正式圖片後改該檔的 `image` 路徑即可。
立場球的骨架樣式（E/A/C/N/O）與顏色（hue）也在同一個檔案設定。

## 啟動 / cloudflared 部署

```bash
cp .env.example .env   # 預設值即可用（同源 proxy），只需填 VITE_MOBILE_BASE_URL
npm install
npm run dev            # http://localhost:5174
```

cloudflared 部署（單一 tunnel 打通前後端）：REST 與 WS 預設走「同源
相對路徑」，由 vite proxy 轉發到 localhost:8200，因此只要
`cloudflared tunnel --url http://localhost:5174` 一條 tunnel 就能對外，
沒有 CORS / mixed content 問題（https 頁面自動用 wss）。mobile 另開一條
tunnel，把網址填進 `.env` 的 `VITE_MOBILE_BASE_URL`（QR 要給手機掃）。
完整步驟見 `.env.example` 檔尾備忘。

後端需先啟動（`voice_clone_backend`，port 8200）。本專案用到的後端擴充
（皆向後相容）：`OnboardingSession.voice_reference_text`、
`OnboardingResult.scenarios`、`init_debate_session.max_turns`。
手機端報告視圖：`voice_clone_mobile` ResultPage 依 `result.scenarios`
有無自動切換三情境報告/單場判決書。
