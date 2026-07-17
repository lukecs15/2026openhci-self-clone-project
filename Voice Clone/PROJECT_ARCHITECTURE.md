# 「內在法庭」專案架構總覽

> 三端一體的 VR 體驗：**手機（mobile）** 填問卷＋錄音建立「自我」agents →
> **Unity（Quest 2 VR）** 開庭，兩位人格 agent 激辯、法官（體驗者）敲槌介入 →
> **後端** 負責 LLM 辯論生成、聲音克隆 TTS、STT、判決書生成。
> 另有一個 **網頁版前端**（voice_clone_frontend，辯論模式的 2D 原型/除錯介面）。
>
> 本文件是三端架構的鳥瞰圖；更深入的細節見各端自己的文件：
> 後端 `voice_clone_backend/README.md`、Unity `openHCI_G2/VR_SYSTEM_DESIGN.md`。

---

## 一、整體資料流（一次完整體驗）

```
┌─────────┐  ① 掃 Unity HUD 上的傳票 QR（/link?session=<id>）
│ 手機     │  ② 15 題 Big Five 問卷 → 錄 5-60 秒煩惱口供 → 選議題
│ mobile   │  ③ POST /api/onboarding-sessions/{id}/link（問卷分數+錄音+議題）
└────┬────┘         │ 後端：建立聲音克隆 profile + 5 位「自我」agent
     │              ▼
┌────┴────┐  ④ Unity 輪詢 GET /api/onboarding-sessions/{id} 直到 linked
│ Unity VR │  ⑤ 挑最對立的 2 位 agent → WS /ws/voice-debate/{id} 開庭辯論
│ Quest 2  │  ⑥ 法官敲法槌 → 錄音 → user_intervene_audio（後端 STT 轉錄）
└────┬────┘  ⑦ 3 次介入用完/回合上限 → end_session → 判決書（LLM 生成 JSON）
     │       ⑧ POST /{id}/result 回寫判決 → HUD 顯示領取 QR
┌────┴────┐  ⑨ 手機掃第二個 QR → GET /{id}/result → ResultPage 顯示判決書
│ 手機     │
└─────────┘
```

---

## 二、後端 `voice_clone_backend/`（FastAPI，port 8200）

### 2.1 分層

```
main.py                 FastAPI 入口（CORS 放行 *.trycloudflare.com）
config.py               Settings（.env）：device_profile、LLM/TTS/STT 引擎、
                        debate_max_turns、debate_max_pacing_seconds（預設 0，已停用）
models/schemas.py       所有 Pydantic DTO + WebSocket 協定文件（檔尾有完整協定說明）

routers/                對外介面層
  ws_debate.py            辯論模式 WS（本專案主線）：_run_debate_loop 背景生成
                          ＋「預生成下一輪」穿透式串流（見 2.3）
  ws_voice_agents.py      一般多 Agent 對話 WS（Handoff/Job Group，未搬上 VR）
  onboarding.py           REST：/api/onboarding-sessions/{id}（查詢/link/result 讀寫）
  qr.py                   REST：/api/qr?data=...（產 QR PNG，Unity 的傳票/領取 QR）
  voice_profiles.py       REST：聲音樣本上傳 → 克隆 profile

agents/                 對話編排層（只吃/吐 JSON 事件，前端無關）
  debate.py               DebateOrchestrator：雙 agent 輪流辯論、插話注入、
                          snapshot/rollback（投機生成回滾）、判決書/總結生成
  orchestrator.py         MultiAgentOrchestrator（一般對話模式）
  handoff.py / job_group.py / base_worker.py（一般模式的路由/分工）

pipeline/               膠水層（依 config 組裝 services + agents）
  debate_pipeline.py      DebateSession（含 VR 語音插話的 STT 委派）
  conversation_pipeline.py

services/               能力層
  llm_service.py          OpenAI/Gemini 串流 + SentenceAggregator 逐句斷句
  tts_service.py          CosyVoice 2 zero-shot 克隆（獨立常駐 server 行程，
                          WS 串流吐裸 16-bit mono PCM chunk）；MockTTSService
  stt_service.py          雙引擎：Breeze ASR（主，台灣腔）+ faster-whisper（備援），
                          主引擎逾時/失敗自動切換
  onboarding_session_service.py   session 狀態存檔（onboarding_sessions/）
  voice_profile_service.py        克隆 profile 管理（voice_profiles/）
  personality_mapping.py          Big Five 分數 → 5 位「自我」agent 人格
  topic_derivation.py             從錄音逐字稿自動推導辯論議題
```

### 2.2 辯論模式 WS 協定（`/ws/voice-debate/{session_id}`）

Client→Server：`init_debate_session`、`pause_debate`、`user_intervene`（文字）、
`user_intervene_audio`（VR 語音，base64 WAV）、`turn_played`（真實播放回報）、`end_session`
Server→Client：`debate_ready`、`agent_speaking_start/chunk/end`（chunk 帶 base64 PCM）、
`debate_paused`、`user_transcript`、`user_intervene_ack`、`debate_finished`、
`session_summary`（含結構化 `verdict` 判決書）、`error`

### 2.3 延遲優化重點（2026-07）

- **預生成下一輪（穿透式串流）**：前端播這輪時就生成下一輪；釋出閘門
  （turn_played + 0.6s 停頓）開啟前扣在 buffer、開啟後直通串流。
  插話時「已生成但沒人聽過」的投機輪用 snapshot/rollback 整輪丟棄。
- **節奏控制停用**（`debate_max_pacing_seconds=0`）：turn_played 真實回報取代估計值等待。
- 生成深度上限固定一輪，不會在背後無限往後生。
- 測試：`tests/test_ws_debate.py`（含投機/回滾行為）、`test_debate.py` 等，`pytest` 全綠。

---

## 三、Mobile `voice_clone_mobile/`（React + Vite，手機瀏覽器）

```
src/
  App.jsx                 依網址分流：/link → OnboardingFlow；/result → ResultPage
  pages/
    OnboardingFlow.jsx      主流程（單一元件的 step 狀態機）：
                            opening → welcome（電子傳票）→ questionnaire（15 題
                            Big Five）→ record（錄煩惱口供 5-60s）→ topic（選議題）
                            → connect（掃傳票 QR/手動輸入 session id）→ submitting
                            → done → result-scan（掃領取 QR 看判決）
    ResultPage.jsx          判決書結果頁（融合波形 + 判決內容）
  store/
    questionnaireFlow.js    Big Five 計分（純函式）
    progressPersistence.js  進度保存/還原（localStorage + TTL，2026-07 新增：
                            手機切走 app 頁面被回收重載後可接續進度；錄音 Blob
                            不保存、退回 record 重錄；TTL 由 .env 的
                            VITE_PROGRESS_TTL_MINUTES 控制，預設 60 分鐘）
  api/onboardingClient.js   REST 呼叫（VITE_API_BASE_URL）
  data/                     bigFiveQuestions（15 題）、oceanDims、logoGlyph
  components/               法庭風視覺（CourtOpening/CourtWaves/LawyerAvatar/
                            QrScanner/CourtMicVisualizer…）
  utils/                    sessionLink（QR 文字→session id）、waveform* 波形視覺
                            （與網頁版/Unity 共用同一套簽章演算法）
  __tests__/                vitest（questionnaireFlow / sessionLink /
                            progressPersistence）
```

`.env`：`VITE_API_BASE_URL`（後端位址，實機測試要用區網 IP 或 tunnel）、
`VITE_PROGRESS_TTL_MINUTES`（進度保存有效時間）。

---

## 四、Unity `openHCI_G2/`（Unity 6000.4.6f1，URP，Meta Quest 2）

場景：`Assets/tmp.unity`。腳本：`Assets/Scripts/VoiceDebateVR/`。
完整的場景物件對照表與踩坑紀錄見 `VR_SYSTEM_DESIGN.md`。

### 4.1 分層（對照後端/網頁版）

```
Protocol/    DebateProtocol.cs         WS 訊息 DTO（對照 schemas.py）
Networking/  DebateWebSocketClient.cs  原始 WS 連線 + 送出佇列
             OnboardingApiClient.cs    REST（傳票/領取 QR、輪詢 linked、回寫結果）
             BackendConfig.cs          後端位址 ScriptableObject
Session/     DebateSessionController.cs  中樞：事件序列化管線（嚴格按序、chunk
                                         播完才處理下一個、epoch 作廢機制、
                                         HoldPlayback/ReleasePlayback 播放閘門）
             DebateSessionState.cs        純函式狀態機（對照 reducer）
             CourtExperienceDirector.cs   體驗總導演：WaitingForLink → AwaitSeating
                                          → CourtOpening → Debate → VerdictCeremony
                                          → End 六階段 + 除錯熱鍵（R 重來/G 模擬敲槌
                                          /T 文字插話/E 直接終結）
             SelfAgentSelector.cs         從 5 位自我挑最對立的 2 位
Audio/       AgentAudioChannel.cs      TTS PCM 播放（雙 AudioSource + PlayScheduled
                                       無縫排程，2026-07）
             MicInterveneRecorder.cs / WavEncoder.cs   法官插話錄音 → WAV base64
Avatar/      AgentEnergyAvatar.cs 等   程序化能量球（波形簽章與網頁/手機共用演算法）
             AgentMergeConverge.cs     結尾融合動畫
Interaction/ GavelStrikeDetector.cs    法槌敲擊物理偵測
             JudgeInterventionController.cs  敲槌→暫停→錄音→送出 狀態機（3 次上限、
                                             interventionAllowed 總開關）
             JudgeSeatTrigger.cs       就座偵測（開庭觸發）
Staging/     CourtroomLightingDirector.cs  頂燈依序點亮/暗場演出
UI/          CourtHud.cs               統一 HUD（平滑跟隨頭部的 World Space Canvas，
                                       所有 2D 資訊集中：字幕/QR/法槌狀態/對話/判決書）
             HudTopmostRenderer.cs + HudOverlayUI.shader   HUD 永遠蓋在場景物件上
             CourtHudSpeechCaption.cs  人格對話字幕（只顯示當前發言）
             SubtitleAnnouncer.cs      旁白/廣播（音檔可後補，無音檔依字數估時）
             VerdictPanel.cs           計算進度條 + 判決書內頁 + 領取 QR
             JudgeBenchUI.cs           法槌狀態/剩餘次數（SetSuppressed 分階段顯示）
```

### 4.2 體驗流程與延遲設計

- 開場宣告期間就先 Connect+Init（後端預生成第一輪，播放閘門扣住，宣告完零等待開播）。
- 辯論中：字幕在 chunk「排定開播」的時間點才顯示（音字對齊）；`turn_played`
  等排程佇列真的播完才送（後端節奏的真實依據）。
- 終結儀式開頭就送 `end_session`，判決書生成與宣告/暗場演出並行。

---

## 五、跨端共用的設計約定

- **波形人格簽章**：`waveformSignature`（頻率/振幅/波高/波形/顏色五參數）演算法在
  網頁、手機、Unity 三處各有同構實作，同一個 agent_id 三端外觀一致。
- **音訊格式**：後端 TTS 吐裸 16-bit mono PCM（base64）；Unity 插話錄音固定
  16kHz mono WAV（後端 soundfile 直讀，不走 PyAV fallback）。
- **時序真實回報**：前端（網頁與 Unity 皆同）播完一輪才送 `turn_played`，
  後端最多領先一輪，保證插話時打斷的是使用者正在聽的對話進度。
- **優雅降級**：TTS 失敗吐無聲 chunk 繼續辯論；判決書 JSON 解析失敗退化成
  純文字；STT 主引擎失敗自動切備援；mobile 進度快照非法/過期整份作廢。

## 六、開發/部署備忘

- 後端啟動：`uvicorn main:app --reload --host 0.0.0.0 --port 8200`（必須綁 0.0.0.0）。
- Quest 2 與後端需同網段；mobile 走 cloudflared tunnel 時 CORS 已用 regex 放行。
- 開發機沒有 GPU/麥克風時：TTS/STT/LLM 都有 Mock（`DEVICE_PROFILE=dev`），
  Unity 熱鍵 T 可無麥克風文字插話。
- 已知限制清單（重連機制、ClientWebSocket 於 IL2CPP 未實測等）見後端 README
  第十一節與 `VR_SYSTEM_DESIGN.md` 第八章。
