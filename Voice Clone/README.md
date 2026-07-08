# Voice Clone — 台灣腔克隆語音多 Agent 對話系統

本模組是獨立於 `../backend` / `../frontend`（Drawing to 3D 專案）之外的新子系統，
實作先前架構討論定案的「多 Agent 語音克隆對話」小模組，目前重點是**驗證架構與
邏輯正確性（可測試）**，尚未整合真正的 CosyVoice 2 / Breeze ASR 模型權重。

```
Voice Clone/
├── voice_clone_backend/    FastAPI + 多 Agent 編排（Pipecat 風格）+ STT/LLM/TTS 服務
└── voice_clone_frontend/   React (Vite) 前端：多 Agent 對話介面
```

## 一、整體管線

```
使用者聲音 → STT（雙引擎：常用 + 備援）→ LLM 回覆生成（雲端串流）
  → 逐句斷句（SentenceAggregator）→ TTS（CosyVoice 2 串流合成）→ 音訊播放
```

多 Agent 發話順序由 `agents/` 內的兩種協調器決定：

- **Handoff**（`agents/handoff.py`）：序列（依序）交接。
    - 使用者訊息提到某個 agent 的名字 → 只由該 agent 回應（同時提到多個名字時，
      挑文字中「最先出現」的那一個，而不是候選名單順序）。
    - 沒有指名 → **全體依序輪流各自回應一次**（像小組討論：使用者說一句話，
      agent A 先完整回完、接著 B、再來 C，不是平行同時講）。這是預設行為。
    - `agent_routing_strategy=llm_decision` 時改成真的呼叫 LLM 判斷「這句話該
      由誰回應」（見 `build_llm_routing_decision_fn()`），語意判斷比字串比對準確。
- **Job Group**（`agents/job_group.py`）：平行分派給多個 agent「同時」處理，
  適合腦力激盪 / 多角色同時發言情境（`should_use_job_group()` 偵測訊息是否包含
  「大家」「所有人」等關鍵字，觸發時才會走這條路）。
- **辯論模式**（`agents/debate.py`，獨立於上面兩種協調器，見第八節）：固定兩位
  agent 圍繞單一主題輪流發言，支援使用者隨時暫停、插話。

Handoff（依序）與 Job Group（平行）的差異是「agent 之間要不要互相等待」，
不是「回應的 agent 數量」——兩者現在都可能是全部 agent 一起參與，只是順序
邏輯不同。詳細設計理由見各檔案開頭 docstring，皆對照原始架構討論文件的章節編號。

## 二、兩套硬體設定檔（重要）

本模組刻意支援 `DEVICE_PROFILE=dev`（開發機）與 `DEVICE_PROFILE=prod`（正式機）
兩種設定，因為目前開發機與最終部署機的 VRAM 差距很大：

| | 開發機（目前） | 正式機（目標） |
|---|---|---|
| GPU | GTX 1660 Ti（6GB GDDR6） | RTX 5090（32GB GDDR7） |
| STT 主引擎 | faster-whisper（small，做管線驗證） | Breeze ASR 25/26（台灣腔優化） |
| STT 備援 | faster-whisper | faster-whisper（large-v3） |
| TTS | MockTTSService（不載入模型，純驗證協定） | CosyVoice 2（本地常駐 WebSocket 服務） |
| torch dtype | float16 | bfloat16（Blackwell 原生加速） |

切換方式只需改 `.env` 的 `DEVICE_PROFILE`，其餘欄位會依 profile 自動套用合理預設值
（見 `voice_clone_backend/config.py` 的 `apply_profile_defaults()`），也可個別覆寫。

**STT / LLM / TTS 三者的 mock 與否現在各自獨立判斷**（修過的耦合問題）：STT 一律走
真正的雙引擎邏輯；LLM 只要 `.env` 填了對應 provider 的 API key 就會自動使用真正的
雲端 LLM（跟 TTS 是否為 mock 無關，可用 `FORCE_MOCK_LLM=true` 強制關閉）；TTS 由
`TTS_ENGINE` 決定。也就是說在 GTX 1660Ti 上，只要填了 `GEMINI_API_KEY`，就能測試
「真的呼叫 Gemini」的完整對話品質與延遲，即使 TTS 仍然是 mock（不需要裝 CosyVoice 2）。

### 2.1 開發機設定（GTX 1660 Ti）

```bash
cd voice_clone_backend
python -m venv venv
# Windows: venv\Scripts\activate ; Linux/Mac: source venv/bin/activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements/base.txt
pip install -r requirements/dev-gtx1660ti.txt

cp .env.example .env
# .env 內確認：
#   DEVICE_PROFILE=dev
#   TORCH_DEVICE=cuda        # 無 GPU 則改 cpu
#   TTS_ENGINE=mock          # 6GB VRAM 建議先用 mock 驗證管線
#   STT_PRIMARY_ENGINE=faster_whisper
#   GEMINI_API_KEY=你的金鑰   # 填了就會真的呼叫 Gemini；留空則自動用假回覆

uvicorn main:app --reload --port 8200
```

在這台機器上，「多 Agent 編排邏輯 + WebSocket 協定 + STT 雙引擎切換 + 逐句斷句
+ 使用者聲音克隆 profile 的上傳/建立 + 真正的雲端 LLM 對話」都可以完整測試
（見下方「執行測試」），只有 CosyVoice 2 / Breeze ASR 的**真實推理**需要等搬到
RTX 5090 才能驗證。

### 2.2 正式機設定（RTX 5090）

```bash
cd voice_clone_backend
python -m venv venv && source venv/bin/activate
pip install torch>=2.7.0 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
pip install -r requirements/base.txt
pip install -r requirements/prod-rtx5090.txt

# 依 CosyVoice 2 官方 repo 安裝並下載權重：
# https://github.com/FunAudioLLM/CosyVoice
# 權重路徑填入 .env 的 COSYVOICE_MODEL_PATH

cp .env.example .env
# .env 內確認：
#   DEVICE_PROFILE=prod
#   TORCH_DTYPE=bfloat16
#   STT_PRIMARY_ENGINE=breeze
#   BREEZE_ASR_ENABLED=true
#   WHISPER_MODEL=large-v3
#   TTS_ENGINE=cosyvoice2
#   COSYVOICE_MODEL_PATH=/path/to/cosyvoice2/weights

# 先啟動 CosyVoice 2 常駐服務（獨立行程，localhost 呼叫）
python -m services.cosyvoice_server &

uvicorn main:app --reload --port 8200
```

## 三、STT 雙引擎策略（常用 + 備援）

對照架構討論的結論：Breeze ASR 25/26（MediaTek Research）作為**主引擎**
（台灣腔、中英夾雜優化），faster-whisper 作為**備援**（通用、速度快）。

- `services/stt_service.py` 的 `STTService` 先呼叫 primary，設定
  `STT_PRIMARY_TIMEOUT_MS`（預設 1500ms）逾時保護；一旦逾時或拋例外，
  立即切換 fallback。**fallback 也有自己的逾時保護**（`STT_FALLBACK_TIMEOUT_MS`，
  預設 8 秒）——這是修過的一個真實 bug：過去 fallback 完全沒有逾時保護，
  若 primary/fallback 都指向同一種引擎（dev 環境預設如此）且模型權重延遲載入，
  一旦下載卡住會讓整個請求無限期 hang 住（例如上傳聲音樣本後「處理中」永遠
  不結束）。現在兩層都逾時的話會直接拋出明確錯誤，不再無限等待。
- 音訊解碼（`decode_audio_bytes_to_mono_float32()`）會先試 soundfile，失敗
  （常見於瀏覽器 MediaRecorder 輸出的 webm/opus，soundfile 不支援這個容器）
  就改用 pydub + ffmpeg 轉檔。**這步驟需要系統安裝 ffmpeg**（見
  `requirements/base.txt` 註解），沒裝的話 webm/opus 錄音會轉錄失敗
  （不影響 WAV 檔案上傳）。
- 這個「主/備切換 + 雙層逾時」邏輯已在 `tests/test_stt_service.py` 用假引擎
  （可控制延遲/例外）完整測試，開發機不需要真的裝 Breeze ASR 也能驗證正確性。
- Breeze ASR 的實際推理程式碼目前是 `NotImplementedError` 骨架
  （`services/stt_service.py` 的 `BreezeASREngine._run_inference`），
  需在正式機安裝 `funasr` 後補上（見程式碼內 TODO）。

## 四、使用者聲音克隆（上傳音訊 → 克隆聲音 → 指派給 agent）

需求：使用者可以自己丟入一段音訊，克隆出自己的聲音，指派給某一個 agent，
或是套用到全部 agent，讓對話中該 agent（們）用使用者的聲音回覆。

**後端**（`services/voice_profile_service.py` + `routers/voice_profiles.py`）：

```
POST   /api/voice-profiles/upload-sample   上傳錄音樣本 → 回傳暫存檔名
POST   /api/voice-profiles/clone           建立 VoiceProfile（自動用 STT 轉錄逐字稿）
GET    /api/voice-profiles                 列出所有已建立的 profile
DELETE /api/voice-profiles/{profile_id}    刪除 profile
```

CosyVoice 2 走 **zero-shot 克隆**：不需要另外訓練/微調，只需要一段 3-10 秒的參考
音訊 + 這段音訊的逐字稿（`inference_zero_shot` 的 `prompt_text` 參數）。使用者通常
不會自己打逐字稿，所以 `create_profile()` 預設會呼叫既有的 `STTService` 自動轉錄，
失敗也不會擋住建立流程（`reference_text` 留空即可，之後可以手動補），且該次轉錄
一樣受第三節的雙層逾時保護，不會無限期卡住。

Profile 採**檔案式儲存**（`voice_profiles/profiles.json` + 音檔），因為 CosyVoice 2
的實際推理常駐在獨立 process（`services/cosyvoice_server.py`），跟主 API 是兩個
process，沒辦法共用 Python 記憶體，所以落地成檔案讓兩邊都能讀到。

`AgentConfig.voice_profile_id` 決定某個 agent 要用哪個 profile；`services/tts_service.py`
的 `resolve_voice_profile()` 負責把 id 換成實際的參考音訊路徑 + 逐字稿，`CosyVoiceModelServer`
未來接上真實模型時直接呼叫這個函式即可（見程式碼內 TODO）。

**前端**（`components/VoiceProfileUploader.jsx` + `store/voiceProfileAssignment.js`）：

開始對話前，使用者可以錄音或上傳音檔，建立 profile 後選擇套用範圍——單一 agent
或全部 agent（`applyVoiceProfileToAgents(agents, profileId, target)`，`target` 傳
`'all'` 或某個 `agent_id`），套用結果會反映在送出的 `init_session` 訊息裡。

> 目前 GTX 1660Ti 上這條路徑走的是 MockTTSService：profile 上傳、自動轉錄、
> 指派邏輯都是真的在跑，只有最後「用克隆聲音真的念出來」是靜音假資料，
> 等 RTX 5090 上 CosyVoice 2 接上真實推理後，同一套流程不需要改。

## 五、CosyVoice 2 台灣腔精準度（待辦）

CosyVoice 2 本身非台灣腔專用模型，`config.py` 保留了
`COSYVOICE_TAIWAN_LORA_PATH` 欄位，供之後放入台灣腔微調權重。
在權重就緒前，`tts_engine=mock` 讓整條管線可以先跑通。

BreezyVoice（MediaTek Research，原生台灣腔、5 秒即可克隆）是備選方案，
但目前基於 CosyVoice 1 代、串流延遲較差，見架構文件 2.4 節的取捨說明。

## 六、執行測試

### 後端（pytest，全部 mock，無需 GPU / API key）

```bash
cd voice_clone_backend
pip install -r requirements/base.txt -r requirements/dev-gtx1660ti.txt
pytest -v
```

108 個測試，涵蓋範圍：STT 主備切換（逾時/例外/正常，含「primary 與 fallback
都逾時」的迴歸測試）、音訊解碼（WAV 直接解、非 WAV 容器 fallback 到 pydub）、
LLM 逐句斷句（SentenceAggregator 各種邊界情況）、Gemini/OpenAI 角色對應、
Handoff 決策（指名單一 agent，含「同時提到多個名字時挑最先出現的那一個」的
迴歸測試／沒指名時全體依序輪流／`llm_decision` 真正呼叫 LLM 判斷路由，含
逾時與例外 fallback）、Job Group（平行分派、單一 agent 失敗隔離、
max_concurrency 限制）、Orchestrator 端到端事件流（handoff 序列、job_group
平行、agent_speaking_chunk 文字不重複、對話歷史加上發言者名稱前綴、LLM
自我前綴模仿的防呆迴歸測試）、**辯論模式**（`agents/debate.py`：雙 agent
輪流發言、暫停＝取消生成不留殘留狀態、插話後由原本被打斷的 agent 接續回應、
達到回合上限自動結束、節奏控制依音訊長度換算等待秒數並可被上限截斷、取消
發生在節奏控制等待期間效果跟取消發生在生成期間一致；`routers/ws_debate.py`
的 `_wait_for_turn_ack()`：事件已經 set 時立即返回、逾時後放棄等待不拋例外；
`_run_debate_loop()`：用真正的 DebateOrchestrator（max_turns=1）驗證達到
回合上限的最後一輪也會先等 turn_played ack 才送出 debate_finished、ack
提早到達時不會被無謂拖慢）、pipeline 組裝層（`build_test_conversation_session`
/ `build_test_debate_session`、LLM mock/real 自動判斷邏輯、`routing_strategy`
未指定時正確 fallback 用後端設定值）、使用者聲音克隆 profile 的上傳/建立/
查詢/刪除、自動轉錄逐字稿、以及 TTS 服務正確查到指派給 agent 的克隆聲音 profile。

### 前端（vitest，純邏輯測試，無需啟動瀏覽器）

```bash
cd voice_clone_frontend
npm install
npm test
```

120 個測試，涵蓋範圍：`agentSessionReducer` / `debateSessionReducer` 狀態機
（WebSocket 事件如何驅動 UI 狀態，含多 agent 同時發話情境、暫停/插話狀態轉換、
「chunk 文字為空不重複記錄 transcript」的迴歸測試）、`applyVoiceProfileToAgents`
/ `clearVoiceProfileFromAgents`（套用到單一 agent、套用到全部 agent、不可變性、
找不到 target 時的行為）、`sendQueue`（WebSocket 連線還沒 OPEN 時的訊息佇列，
修過的 init_session 遺失 bug）、`voiceAgentClient` / `voiceDebateClient` 的
WebSocket 訊息組裝函式（含 `routing_strategy` 未指定時不應該出現在訊息裡的
迴歸測試、`buildTurnPlayedMessage()` 組出含 agent_id 的 turn_played 訊息）、
瀏覽器端 TTS/STT 測試替代方案（`browserTts` / `browserStt`）、
`agentSpeakingSync`（發話高亮對齊實際播放結束時間）、`waveformSignature`
（決定性、範圍邊界、`waveform_signature` 覆寫欄位優先、`applyEmotionSignal`
情緒疊加與 clamp、絕對不改動 waveHeight、`colorIntensity` 疊加/clamp/缺
欄位防呆、`lerpSignatureTowards` 逐欄位線性插值）、`waveformPath`
（`buildWavePath` 決定性、speakIntensity/waveHeight 影響振幅、取樣點
clamp 在畫布範圍內、`verticalOffset`/`ampScale` 多層波場參數、
`lerpTowards` 線性插值行為）、`emotionSignal`（`analyzeTurnEmotion`
決定性、空字串安全、標點/關鍵字次數封頂、多特徵疊加、`intensityDelta`
情緒強度→顏色鮮明度，見第九節）、`waveformColor`（`buildWaveformColors`
決定性、colorIntensity 越高顏色越飽和明亮、超出 [0,1] 時 clamp、
bgStop1 色相偏移換算、`bandColor(offset)` 明亮度偏移）。

> 注意：前端測試只驗證狀態機/邏輯本身，不啟動真正的 WebSocket 連線、麥克風或
> 後端 API，因此在任何機器（包含沒有 GPU 的開發機）都能執行。

## 七、WebSocket 協定

前端 ↔ 後端走 `WS /ws/voice-agents/{session_id}`，完整訊息格式見
`voice_clone_backend/models/schemas.py` 檔尾的 `ClientMessage` / `ServerMessage`
說明區塊，摘要如下：

```
Client → Server:
  init_session { agents, routing_strategy }
  user_audio   { audio: base64 }
  user_text    { text }
  end_session  {}

Server → Client:
  session_ready       { agents }
  user_transcript     { text, engine_used, used_fallback }
  routing_decision    { mode: "handoff" | "job_group", agent_ids }
  agent_speaking_start { agent_id }
  agent_speaking_chunk { agent_id, text, audio: base64 }
  agent_speaking_end   { agent_id }
  error                { message }
```

`agent_speaking_chunk` 的 `text` 只會在該句「第一個」音訊 chunk 出現，之後的
chunk `text` 是空字串（前端不應該為空字串再記一筆 transcript，只需要照樣播放
音訊）——修過的重複顯示 bug，見第六節測試說明。

前端連線後應該立刻呼叫 `initSession()`，不需要自己抓時間點：訊息會透過
`utils/sendQueue.js` 排隊，等 WebSocket 的 `onopen` 觸發時自動送出。

`routing_strategy` 欄位**可以不傳**（前端 `initSession(agents)` 不帶第二個參數）：
不傳時後端會用 `.env` 的 `AGENT_ROUTING_STRATEGY` 設定值，只有前端明確指定時
才會覆蓋（修過的 bug：過去前端在多個層級都預設寫死 `'heuristic'`，導致就算
`.env` 設成 `llm_decision` 也永遠不會生效——見 `VoiceAgentsPage.jsx` /
`useVoiceAgentSession.js` / `voiceAgentClient.js` 的檔案開頭說明）。

聲音克隆 profile 走一般 REST（見上方第四節），不透過 WebSocket。

## 八、辯論模式（自我省思／自我成長主題）

需求：使用者進入對話前先選一個自我省思／自我成長主題，再從三位 agent 中選
兩位，讓這兩位 agent 圍繞主題輪流發言、進行辯論或討論；使用者聆聽過程中可以
隨時按下暫停，立刻中斷 agent 正在生成/播放的那句話，輸入一句話插話後，由
「原本被打斷的那位」agent 根據插話內容接續回應。

### 8.1 前端流程（`pages/VoiceAgentsPage.jsx`）

模式切換是**畫面裡的下拉選單**，不是最上層的切換 bar（曾經的 UX 調整：一開始
放在 `App.jsx` 最上層的獨立切換列，後來改成 `VoiceAgentsPage.jsx` 開始畫面裡
「路由策略」選單下方的「模式」選單，兩個模式共用同一個進入畫面與同一份
`agents` state，`pages/DebatePage.jsx` 目前未被使用，保留檔案內容以防之後
需要參考）：

1. 「模式」選單選「自我省思辯論」，畫面會多出主題與 agent 選擇區塊
2. 選一個主題（`api/voiceDebateClient.js` 的 `DEBATE_TOPIC_OPTIONS`，三選一：
   如何面對失敗與挫折 / 如何設立個人界線 / 如何克服拖延建立自律）
3. 選兩位 agent（三選二，選擇順序即發言順序，第一個選的先開口；agent 清單
   跟一般多 Agent 對話共用，包含已套用的聲音克隆 profile）
4. 開始討論 → `components/DebateStage.jsx`：兩位 agent 交替發言，畫面右下角
   有一個**半透明、不干擾**的「結束討論」按鈕（預設低透明度，滑鼠移過去才
   變明顯），點擊直接結束整個 session、回到選主題畫面
5. 按「暫停並插話」→ 立刻停止目前播放的音訊/瀏覽器 TTS 朗讀（`useDebateSession.js`
   的 `stopAllPlaybackImmediately()`），同時送出 `pause_debate` 給後端
6. 插話：直接打字送出，或開啟「用瀏覽器語音辨識插話」開關後按住說話——辯論
   模式後端本來就沒有像一般多 Agent 對話那樣的 `user_audio`／後端 STT 路徑
   （`user_intervene` 訊息設計上就是純文字），所以語音插話一律靠瀏覽器端
   Web Speech API 就地辨識再送出文字，跟後端 STT 是否 mock 無關
7. 「用瀏覽器語音朗讀」開關則跟一般多 Agent 對話一樣，後端 TTS 是 mock 時
   可以用瀏覽器內建語音把 agent 的文字唸出來，方便實際感受下方 8.3 節的
   節奏控制效果

### 8.2 後端架構（`agents/debate.py` + `routers/ws_debate.py`）

跟一般多 Agent 對話（`WS /ws/voice-agents/{session_id}`）走**獨立的**
`WS /ws/voice-debate/{session_id}` 端點，因為互動模式差異夠大，不共用
`ClientMessage` / `ServerMessage`（見 `models/schemas.py` 的
`DebateClientMessage` / `DebateServerMessage`）：

```
Client → Server:
  init_debate_session { topic_id, agents }   # agents 恰好 2 位，第一位先開口
  pause_debate         {}                    # 立刻中斷目前正在生成/播放的那句話
  user_intervene        { text }             # 插話（通常在 pause_debate 之後送出）
  end_session           {}

Server → Client:
  debate_ready          { agents, topic_id, topic_title }
  agent_speaking_start   { agent_id }
  agent_speaking_chunk   { agent_id, text, audio: base64 }
  agent_speaking_end     { agent_id }
  debate_paused          { agent_id }        # 暫停成功，該 agent 的生成已中斷
  user_intervene_ack     { text }            # 插話已記錄，即將由暫停的 agent 接續回應
  debate_finished        {}                  # 達到 DEBATE_MAX_TURNS 上限，自然結束
  error                  { message }
```

**「暫停＝立刻中斷生成」是怎麼做到的**：一般多 Agent 對話的 WebSocket 迴圈是
「收到一則訊息才處理、處理完才收下一則」，如果辯論模式沿用同一套寫法，主迴圈
會整個卡在生成當前這一輪的 `async for` 裡，完全收不到使用者送來的暫停訊息。
`routers/ws_debate.py` 因此把「讓兩位 agent 一直講下去」的邏輯放進一個獨立的
`asyncio.Task`，事件透過 `asyncio.Queue` 轉發；WebSocket 主迴圈只單純不斷
`await ws.receive_text()`，跟這個背景 task 完全並行、互不阻塞。暫停／插話
= 直接對背景 task 呼叫 `cancel()`，讓它在目前卡住的 LLM/TTS 呼叫處乾淨中斷。
`DebateOrchestrator.run_next_turn()`（`agents/debate.py`）刻意設計成「一輪一輪」
的 async generator、不攔截 `asyncio.CancelledError`：只有整輪生成**成功跑完**
之後才會把發言寫進歷史、切換講者，所以取消發生在任何中途都不會留下講到一半的
殘留紀錄——下一次 `run_next_turn()` 會是同一位 agent，根據（剛插話進來的）
最新歷史重新生成一次完整回覆。

**回合上限**（`DEBATE_MAX_TURNS`，預設 20）：避免使用者忘記按暫停/結束時，
背景一直呼叫 LLM 燒 API 額度、無限講下去；達到上限後端會送出 `debate_finished`
並自然停止。

### 8.3 節奏控制（修過的真實回報問題：來回對答過快）

使用者實測發現兩位 agent 來回對答「過快」，根本原因是 dev 環境 TTS 預設是
`MockTTSService`，文字→斷句→合成幾乎瞬間就能跑完一整輪，換人發言的速度
只受限於 LLM 生成速度，完全沒有「這段話講出來實際要花多少時間」的概念，
跟真人聆聽的節奏對不上。

`DebateOrchestrator.run_next_turn()`（`agents/debate.py`）現在會依每個
`agent_speaking_chunk` 的音訊資料長度與取樣率反推預估播放時長
（`_audio_duration_ms()`，16-bit mono PCM，MockTTSService 的靜音資料一樣
適用，因為時長是從資料長度反推、不是真的解碼音訊），整輪生成結束後、真正
把發言寫進歷史／切換講者／送出 `agent_speaking_end` 之前，用「預估播放
時長 − 生成已經花掉的實際時間」補一段等待（不會是負數，且有
`DEBATE_MAX_PACING_SECONDS`，預設 12 秒，避免單輪講太長的話時等待時間
離譜地久）。真正的 CosyVoice 2／真人聆聽情境下，生成本身可能就已經花了
跟播放差不多的時間，這段補的等待會自動趨近於 0，不會額外拖慢已經夠慢的
真實情境。`routers/ws_debate.py` 另外在換人發言之間加了 0.6 秒固定停頓
（`_INTER_TURN_GAP_SECONDS`），模擬真人對話「等對方講完，稍微停頓一下才
接話」的感覺。

等待的實作（`pacing_sleep_fn`）可以注入，預設用真正的 `asyncio.sleep`；
單元測試會換成立即完成的假版本，避免節奏控制真的拖慢測試套件（見
`tests/test_debate.py`）。取消發生在節奏控制的等待期間，效果跟取消發生在
生成期間一樣（這一輪會被整個丟棄、不留殘留紀錄），因為節奏控制的等待就在
`history.append()` 之前。

### 8.4 前端聲音區隔與時序對齊（修過的真實回報問題）

實測後又發現幾個問題，都在前端 `hooks/useDebateSession.js` 修正，後端不需要改。

**兩位 agent 共用同一個瀏覽器語音**：`enqueueSpeech()` 以前固定傳入字串
`'debate'` 給 `speakWithBrowserTts()` 挑語音（`utils/browserTts.js` 的
`pickVoiceIndexForAgent()` 是依傳入的 id 雜湊挑語音），導致兩位 agent 的
瀏覽器朗讀聽起來是同一個聲音。改成傳入實際的 `agent_id`，跟一般多 Agent
對話（`useVoiceAgentSession.js`）做法一致。真正的 TTS 音訊本來就沒有這個
問題：兩位 agent 的音色由各自的 `voice_profile_id`（克隆聲音）決定，`agents/
debate.py` 的 `_synthesize_and_wrap()` 呼叫 `tts_service.synthesize()` 時
本來就有帶入 `agent.voice_profile_id`，跟一般多 Agent 對話走同一套聲音克隆
生成流程（前端 `VoiceAgentsPage.jsx` 的辯論模式 agent 選擇框也會標示「已套用
克隆聲音」，確認兩個模式共用同一份 agent 設定）。

**文字／發話高亮／語音對不齊、換人發言時聊天視窗一次冒出好幾則訊息、暫停
按了語音還是繼續播**：這三個問題其實是同一個根因，第一版修法（捕捉當下的
播放佇列 Promise、等它 settle 才 dispatch）不夠徹底，改用「單一嚴格序列化
事件管線」才真正解決：

- *根因*：如果同一輪裡好幾個 `agent_speaking_chunk` 事件抵達得很密集
  （`MockTTSService` 幾乎瞬間吐出好幾個 chunk），第一版做法在每個事件抵達
  當下才去讀取「目前佇列」，但這個讀取跟前一個事件真正把內容排進佇列是
  發生在不同的非同步時間點——如果好幾個事件在前一個事件的 callback 真的
  執行之前就已經抵達，它們會讀到同一份還沒更新的舊佇列快照，導致 dispatch
  幾乎同時觸發（文字瞬間跳出來、跟音訊播放進度脫勾），也讓好幾個
  `window.speechSynthesis.speak()` 呼叫在極短時間內接連送出，使瀏覽器原生
  朗讀佇列一次塞進好幾句——`cancel()` 在這種情況下不同瀏覽器行為不一致，
  常常只中斷「目前正在講」的那一句，佇列裡排隊的下一句馬上接著自動播放，
  就是「按了暫停語音還是繼續講」的表面現象。
- *修法*：改成單一 `eventPipelineRef`，收到事件時用
  `eventPipelineRef.current = eventPipelineRef.current.then(processEvent)`
  把處理函式接在管線尾端——這一行在 `ws.onmessage` 裡是同步執行的，所以
  即使兩個事件幾乎同時抵達，第二個事件一定會接在第一個事件「剛剛已經接上」
  的管線尾端，不會有兩者讀到同一份舊快照的競態。每個事件的處理函式會先
  檢查 `dispatchEpochRef` 沒有被暫停打斷，再 dispatch，如果是 chunk 事件
  還要 `await` 這個 chunk 的音訊播放與瀏覽器朗讀都真的播完，管線下一個
  事件才會開始處理，保證任何時刻最多只有一個 chunk 在播放、最多只有一句
  被排進瀏覽器原生朗讀佇列，`cancel()` 只需要中斷「當下這一句」就能讓
  一切安靜下來。
- `dispatchEpochRef` 維持原本的保險機制：暫停/結束時遞增，讓管線裡任何
  「還沒真的 dispatch」的事件之後發現 epoch 對不上就放棄；強制停止目前
  播放的音訊來源／瀏覽器朗讀時會觸發各自的 `onended`/`onerror`，讓正在
  等待這個 chunk 播完的處理函式提前解除等待，管線不會卡住。

真的接上 CosyVoice 2（模型生成 TTS）之後這一整套序列化管線不需要改，音訊
資料本身就是真的會播出來的聲音，`AudioBufferSourceNode.stop()` 是同步、
可靠的中斷方式，天生就比瀏覽器 `SpeechSynthesis.cancel()`（已知在部分瀏覽器
上、佇列有殘留內容時不保證整個佇列都被清空，是瀏覽器實作的已知限制）更好
掌握「現在播到哪裡」與「暫停時真的馬上停下來」；而且因為管線本來就保證
同一時間只有一句在播放，換成真的模型 TTS 也不會有原生佇列塞車的問題——這
也是為什麼「如果用模型生成 TTS 是否比較好掌握播放時間／停止」的答案是
肯定的：模型生成的音訊資料本身就是「真的會播出來的聲音」，時長跟停止都是
前端程式碼可以直接掌控的，不像瀏覽器 TTS 只是文字丟給黑盒子引擎朗讀。

### 8.5 插話後接續回應的 agent 不對、聊天視窗沒自動捲動（修過的真實回報問題）

**插話後接續回應的應該是被打斷的 agent，實測卻是沒被打斷的那個先回覆**：
根因是後端與前端的節奏其實是脫勾的。`DebateOrchestrator.run_next_turn()`
換人發言前的停頓只是「用音訊位元組長度估出來的估計值」，前端實際播放
（尤其開著瀏覽器 TTS 時）常常比這個估計值久；後端過去只依自己的估計值
睡完就直接往下一輪生成，於是背景可能已經跑到比使用者「實際聽到」還後面
的進度——使用者聽感上還在等 agent A 講完，實際上後端的 `current_speaker_id`
已經是 agent B 了，這時按暫停插話，接續回應的自然是後端當下記錄的那個
（錯的）speaker。

修法是加一個 `turn_played` 前端→後端的 WS 交握：前端只有在一輪的
`agent_speaking_end` 事件真正被（已經序列化的）事件管線處理完——也就是
這一輪的音訊與朗讀確定都播完了——才會送出 `{ type: 'turn_played', agent_id }`
（`api/voiceDebateClient.js` 的 `buildTurnPlayedMessage()`，發送點在
`hooks/useDebateSession.js` 的 `agent_speaking_end` 分支）。後端
`routers/ws_debate.py` 的 `_run_debate_loop()` 在生成下一輪之前會等待這個
訊號（`_wait_for_turn_ack()`），這樣後端最多只會領先前端一輪，不會無限
超前；為了避免前端萬一沒送出 ack 導致卡死，設了 20 秒逾時
（`_TURN_ACK_TIMEOUT_SECONDS`），逾時就放棄等待、照舊用固定停頓繼續，只是
記一筆警告 log。`_wait_for_turn_ack()` 抽成獨立函式，`tests/test_ws_debate.py`
單獨測「事件已經 set 立即返回」「事件之後才 set 也能正常等到」「逾時放棄
但不拋例外」三種情境，不需要真的建立 WebSocket 連線。

**聊天視窗有新訊息時要手動捲到最下面才看得到**：`components/TranscriptLog.jsx`
是多 Agent 對話（`VoiceAgentsPage.jsx` 的 chat 分支）與辯論模式
（`DebateStage.jsx`）共用的元件，在清單最後掛一個空 `div`（`bottomRef`），
`transcript.length` 變化時呼叫 `bottomRef.current.scrollIntoView({ block:
'end' })`，兩個模式一次修好、不用各自處理。用 `length` 而不是整個
`transcript` 陣列當依賴，是因為陣列參照每次 render 都可能變、但只在真的
多了一則訊息時才需要捲動。

### 8.6 達到回合上限那一輪也要等播完才送 debate_finished（修過的真實回報問題）

使用者實測發現：到達回合上限時會出現「已達上限」提示、插話按鈕隱藏，但
目前 agent 語音撥完後，另一位 agent 還會接著開口，插話按鈕又跳回來，這時
按暫停能讓聲音停下來，卻打不開插話輸入框——使用者當下猜測是「生成已經到
上限，但語音其實還沒播完」，猜對了。

根因在 `routers/ws_debate.py` 的 `_run_debate_loop()`：8.5 節加的
`turn_played` 等待機制，過去只套用在「還沒結束」的轉場（換下一位 agent
之前），達到 `DEBATE_MAX_TURNS` 真正讓 `orchestrator.is_finished` 變成
`True` 的那一輪反而是唯一沒有等待、直接送出 `debate_finished` 的一輪：
`while` 迴圈在該輪事件都進了 `event_queue` 之後立刻 `break`，
`turn_ack_event` 完全沒被等待過，`debate_finished` 幾乎是緊接在該輪
`agent_speaking_end` 後面就送到前端，這一輪的音訊／朗讀在前端可能還要
好幾秒才會真的播完。更麻煩的是前端 `debate_finished` 是直接 dispatch
（不像 `agent_speaking_*` 事件要排進事件序列化管線、等播放真的完成才
處理），這一輪自己的 `agent_speaking_start` 事件如果排在管線裡稍晚才被
處理到，會把畫面狀態蓋回「進行中」，插話按鈕因此重新跳出來；這時使用者
按暫停送出 `pause_debate`，但後端的 `debate_task` 其實早就 `done()`
（`_run_debate_loop` 已經整個結束），`_cancel_debate_task()` 判斷 task
已完成就不會做任何事，自然也不會回傳 `debate_paused`——前端 `status`
永遠等不到 `'paused'`，插話輸入框（只在 `status === 'paused'` 才顯示）
就一直不會出現。

修法：把 `turn_ack_event` 的等待挪到 `orchestrator.is_finished` 判斷
「之前」，不管這一輪是不是最後一輪都要先等前端回報播完，才決定要不要
`break`——`debate_finished` 因此保證是在最後一輪真的被前端確認播完之後
才會送出。順手把 `_run_debate_loop` 從 `voice_debate_endpoint` 裡的
closure 抽成模組層級函式（`orchestrator` / `event_queue` /
`turn_ack_event` 都改成參數傳入），方便直接用真正的
`DebateOrchestrator`（`max_turns=1`）單元測試這個行為：`tests/
test_ws_debate.py` 新增兩個測試，一個故意不送 ack、驗證最後一輪仍然會
先等滿 `ack_timeout` 才送出 `debate_finished`；另一個模擬 ack 很快送達、
驗證正常情況不會被白白拖慢。

## 九、Agent 頭像動態波形視覺化

需求：agent 頭像改用動態波形呈現，初始波形要能反映 agent 的背景設定，
對話過程中以這個波形為主軸、略為動態調整呈現變化，整體要有沉浸感；波形
的視覺元素對照下表的心理意義設計：

| 波紋元素 | 可代表的心理／敘事意義 |
|---|---|
| 頻率 | 思緒速度、焦慮程度、反覆出現的念頭 |
| 振幅 | 情緒強度 |
| 波高 | 該角色在當下的主導程度 |
| 波形 | 說話方式、人格風格、反應模式 |
| 顏色 | 生命階段、情緒類型或記憶溫度（色相）／情緒激動程度（飽和度、明亮度，見 9.7） |

### 9.1 波形人格簽章（`utils/waveformSignature.js`）

「從 persona_prompt 文字語意分析出這五個參數」這件事，使用者確認之後會
改成用問卷讓使用者自己設定（不分析自由文字），所以目前**刻意先不做文字
語意分析**，只提供一組決定性的預設值：`getWaveformSignature(agent)` 用
`agent_id` 雜湊挑選一個預先設計好的「波形人格」原型（`WAVEFORM_PRESETS`，
六種，例如「沉穩」「焦慮」「果斷主導」，每一種的五個參數都是照上表心理
意義刻意調過的，不是隨機亂數），再加一點依 `agent_id` 決定的小幅 jitter，
讓即使兩個 agent 選到同一個原型，視覺上也會有些微差異。純函式、同一個
`agent_id` 永遠得到同一組結果，重整頁面或換分頁都不會讓頭像「跳掉」。

**接線點（之後問卷流程）**：如果 agent 物件（`AgentConfig`）之後帶有
`waveform_signature` 欄位（結構跟這裡回傳的物件一樣：`{ frequency,
amplitude, waveHeight, waveformShape, hue }`，來源是使用者填問卷後算出來
的真實數值），`getWaveformSignature()` 會直接優先採用該欄位、完全略過
preset 挑選邏輯——`WaveformAvatar` / `AgentStage` 不需要跟著改，只要 agent
物件多了這個欄位就會自動生效，不需要改呼叫端。

### 9.2 波形動畫數學（`utils/waveformPath.js`）

`buildWavePath({ signature, time, speakIntensity, width, height, phaseOffset, verticalOffset, ampScale })`
是完全跟 React/DOM 無關的純函式，把「簽章 + 目前時間 + 說話強度」換算成
一條 SVG path 的 `d` 字串，方便直接用 vitest 驗證波形數學本身，不需要真
的 render 元件、跑 `requestAnimationFrame`：

- **主軸**：任何時刻的波形都是 signature 五個參數決定的基準波形的變形，
  不會因為說話與否整個換一種長相，符合「以這個波形為主軸，略為動態
  調整」的需求。
- **呼吸 envelope**：即使沒人說話，波形也會用一個緩慢週期的正弦波起伏
  （0.85～1.0 倍，週期秒數見 9.6 節），讓頭像感覺「活著」而不是靜態圖案，
  這是沉浸感設計的重要部分。
- **speakIntensity（0～1）**：說話中振幅放大到最多 1.8 倍、相位前進速度
  也加快，讓波形明顯更有活力；這個值不是布林值瞬間切換，而是由呼叫端
  （`WaveformAvatar.jsx`）每一幀用線性插值（`lerpTowards()`）平滑地往
  0 或 1 靠近，說話開始/結束時波形是平滑放大/收斂，不會瞬間跳一下。
- **waveformShape 控制的是「主波形」跟「高頻諧波」的混合比例**：0 接近
  單純正弦波（平滑、規律），1 疊加更多高頻諧波（起伏更複雜、更不規則），
  對應「說話方式、人格風格」的差異。
- 所有取樣點的 y 座標都會 clamp 在 `[0, height]` 內，避免極端訊號組合
  （例如之後問卷流程給出的 amplitude/waveHeight 剛好都貼近上限、又同時
  在說話）理論上讓波形超出 SVG 畫布範圍。

### 9.3 動畫元件（`components/WaveformAvatar.jsx`）

動畫用 `requestAnimationFrame` 迴圈 + 直接對 SVG `<path>` 的 DOM node
呼叫 `setAttribute('d', ...)`，刻意不透過 React state 每一幀觸發
re-render（頭像可能同時有好幾個、每秒要更新好幾十次，用 state 驅動會
造成不必要的 reconciliation 開銷）；真正的波形數學都在 9.2 節的純函式裡，
元件本身只負責「每一幀呼叫它、把結果寫進 DOM」。

### 9.4 波紋鋪滿整個方框背景，不再限縮於圓形

第一版把波形裁切在一個圓形範圍內、呈現成傳統的「頭像」；後續使用者
回饋希望波紋呈現在整個 agent 方框的背景，而不是限縮在圓形裡。作法：
SVG 用固定的邏輯座標系（`VIEW_WIDTH=240, VIEW_HEIGHT=140`）搭配
`width="100%" height="100%"` + `preserveAspectRatio="none"`，讓它直接
撐滿外層容器（`AgentStage.jsx` 裡的 agent 方框），不需要量測容器實際
像素大小；裁切成圓角矩形跟外層容器一致，完全交給外層容器的
`overflow: hidden` + `border-radius` 處理。`AgentStage.jsx` 因此也
重新設計：方框改成 `position: relative` + `overflow: hidden`，
`WaveformAvatar` 以絕對定位鋪滿整個方框當背景，名稱／角色標籤疊在
上層、搭配底部深色漸層維持文字可讀性，方框邊框跟外發光在說話中會用該
agent 的波形色相點亮，呼應波紋本身的顏色。

視覺上不是畫一條線，而是疊 5 層波形（`BANDS` 常數）：每一層用不同的
垂直位移、振幅倍率、相位偏移、透明度（`buildWavePath()` 新增的
`verticalOffset` / `ampScale` 參數），中間幾層振幅最大、最不透明，邊緣
層較弱較淡，疊出一片會流動的波紋場，搭配一層套用高斯模糊的發光層
（沿用中間那層的資料，加粗加模糊）與底色漸層，取代第一版的
glow/echo/primary 三層單線設計，營造更沉浸的氛圍背景。

### 9.5 情緒驅動的波形變化（`utils/emotionSignal.js`）

需求：對話過程中，波形要因為 agent 回覆的情緒而動態調整、試圖改變波的
「形狀」，不是只有「說話中/沒說話」兩種狀態。新增 `analyzeTurnEmotion(text)`
是輕量的文字特徵評分（標點符號 + 關鍵字計數，不呼叫 LLM），把單輪 agent
說的話換算成「相對於基準波形的偏移量」：

- 驚嘆號／疑問句／猶豫語氣（`...`、`…`、`呃`、`嗯`）影響頻率（思緒速度）
  跟波形複雜度；溫暖關鍵字（謝謝、開心、溫暖…）跟緊張關鍵字（焦慮、
  壓力、痛苦…）則影響波形複雜度跟色相偏移方向。
- 每種特徵出現次數的影響力都封頂（`Math.min(count, 3)`），避免長文字
  因為關鍵字/標點重複出現太多次而讓偏移量線性暴走。

`waveformSignature.js` 新增 `applyEmotionSignal(baseSignature, emotion)`
把這個偏移疊加在角色的基準簽章上（clamp 過），**刻意不改動 `waveHeight`**：
波高代表「主導程度」，是角色一直以來的特質，不該因為單輪情緒起伏而改變，
只有頻率/振幅/波形/顏色會隨情緒微調——這樣「以角色波形為主軸，情緒只是
讓它有感地變化」的設計意圖才成立。另外新增 `lerpSignatureTowards()`
逐欄位線性插值，讓 `WaveformAvatar.jsx` 在句子換了、情緒偏移跳動時，
波形是漸變過去，不會瞬間變形（已知簡化：`hue` 沒有處理跨越 0/360 邊界
走最短路徑的情況，實務上情緒造成的色相偏移量不大，不太會真的跨越邊界，
先不處理）。`AgentStage.jsx` 從 `transcript` 算出每位 agent「最新一句話」
的文字（`buildLatestTextByAgent()`），當作 `currentText` prop 傳給
`WaveformAvatar`，驅動這整條情緒鏈路。

### 9.6 流動速度加快

呼應「波的流動速度整體可以再快一點點」的需求，`waveformPath.js` 的
`BREATHE_PERIOD_SECONDS`（不說話時波形仍會緩慢起伏的呼吸週期）從 3.2
秒調快到 2.6 秒，`phaseSpeed`（相位前進速度，決定波形「動得多快」）的
基準值也從 `0.6 + speakIntensity * 0.9` 提高到 `0.9 + speakIntensity * 1.3`
（約快 50%），待機跟說話中的流動感都更有生氣。

### 9.7 顏色也是情緒的變量（`utils/waveformColor.js`）

需求：除了波形形狀，顏色也應該做為情緒的一個變量。原本只有 hue（色相）
會隨情緒偏移一點點，飽和度/明亮度都是寫死的固定值，情緒再激動顏色的
「鮮明程度」也不會變。新增 `colorIntensity`（0～1，`waveformSignature.js`
的 `BOUNDS.colorIntensity = [0.2, 1]`，下限刻意不是 0 避免看起來像壞掉的
死灰色）當作跟 hue 分開的第二個顏色維度：hue 決定「顏色偏向哪裡」（角色
一直以來的特質），colorIntensity 決定「這個顏色現在有多鮮明」（純粹是
情緒驅動、對所有角色一視同仁的基準值 `BASE_COLOR_INTENSITY = 0.55`）。

`emotionSignal.js` 的 `analyzeTurnEmotion()` 新增 `intensityDelta`：
興奮／緊張語氣提高（顏色更飽和明亮），猶豫語氣降低（更黯淡柔和），溫暖
語氣也小幅提高（但幅度比興奮/緊張小），一樣套用 `Math.min(count, 3)` 封頂。
`waveformSignature.js` 的 `applyEmotionSignal()` / `lerpSignatureTowards()`
都同步支援這個新欄位（含缺欄位時的防呆預設值，避免出現 `NaN`）。

新增 `utils/waveformColor.js` 的 `buildWaveformColors({ hue, colorIntensity })`：
純函式，把兩個維度換算成背景漸層、發光層、波形線條實際要用的 `hsl()`
字串，每一組顏色各自在一段「黯淡」到「鮮明」的飽和度/明亮度區間內線性
插值（發光層的插值幅度最大，情緒激動時「發光」的效果最有感；背景漸層
整體偏暗，維持沉靜感不會被情緒推到刺眼）。

這裡也修掉一個連帶發現的問題：原本顏色（hue）只在 `WaveformAvatar.jsx`
render 時從**靜態**的 `signature` prop 算一次，跟動畫迴圈裡逐幀更新的
`effectiveSignature`（情緒疊加+平滑過渡後的「有效簽章」）完全脫鉤——也就是
情緒對 hue 的偏移雖然算出來了，畫面上其實看不出來。修法是把顏色也搬進
`requestAnimationFrame` 迴圈，逐幀用 `effectiveSignature.hue` /
`effectiveSignature.colorIntensity` 呼叫 `buildWaveformColors()`、透過
`setAttribute` 寫進 `<stop>` / `<path>` 的 DOM 屬性，才會真的反映情緒
變化。連帶地，`<linearGradient>` / `<filter>` 的 SVG id 不能再用 hue 組
字串（hue 現在會動態變化，用它當 id 等於每次變化都要新建 DOM 元素），
改用元件掛載時只算一次的穩定 id。

同時也修了另一個連帶發現的問題：`AgentStage.jsx` 原本每次 render 都重新
呼叫 `getWaveformSignature(agent)`，雖然是純函式、值一定相同，但每次都
回傳一組新的物件——而 `WaveformAvatar.jsx` 內部「只有換 agent 才重置、
句子變化時才平滑過渡」的 `useEffect` 是用物件參考比較依賴陣列
（`[signature]`），對話過程中只要 `AgentStage` 因為任何 agent
說話/新訊息而重新 render，就會被誤判成「換了新 agent」而重置，讓形狀跟
顏色的平滑漸變效果被打斷。修法是在 `AgentStage.jsx` 用 `signatureCacheRef`
（`useRef`）讓同一個 `agent_id` 在整個元件生命週期內都拿到同一個物件
參考，從根本解決這個問題（跟波形/顏色本身的計算邏輯無關，是渲染層面的
正確性修正）。

## 十、尚待整合（對照原架構文件「尚待討論」章節）

1. Breeze ASR 25/26 實際推理程式碼（`services/stt_service.py` 的 `BreezeASREngine`）
2. CosyVoice 2 實際推理程式碼（`services/tts_service.py` 的 `CosyVoiceModelServer`）
   ——profile 管理（上傳/自動轉錄/查詢）已完成，缺的是真正呼叫
   `inference_zero_shot()` 那段——以及台灣腔微調權重
3. ~~`agent_routing_strategy=llm_decision` 的真正 LLM 呼叫串接~~ 已完成：
   `agents/handoff.py` 的 `build_llm_routing_decision_fn()` 會用注入的
   `llm_service` 呼叫 LLM 判斷「這句話該由誰回應」，`agents/orchestrator.py`
   建立 `MultiAgentOrchestrator` 時在 `routing_strategy="llm_decision"` 會
   自動組出並注入這個函式，不需要呼叫端額外接線；有逾時保護
   （`AGENT_ROUTING_LLM_TIMEOUT_MS`）與例外防呆，失敗時 fallback 用候選
   名單第一個 agent。目前是用 prompt 要求 LLM 只回傳 JSON 的簡化寫法
   （`parse_llm_tool_call_response` 負責解析），不是 LLM SDK 原生的
   function-calling schema，之後想換成真正的 tool call 只需要改
   `build_llm_routing_decision_fn()` 這一個函式。
4. VAD / turn-detection（目前假設前端已完成語音斷句才送出 `user_audio`；
   辯論模式的使用者插話則刻意只用文字輸入，不需要這塊）
5. 傳輸層：目前用自架 WebSocket，架構文件提及 Daily / LiveKit WebRTC 為
   後續可選傳輸層（`config.py` 的 `transport` 欄位已預留）
6. 延遲實測：STT → LLM → TTS 各段真實延遲，需在 RTX 5090 上實測
7. 音訊品質驗證（`routers/voice_profiles.py` 目前沒有檢查上傳樣本的時長/SNR）
8. 辯論模式主題目前是後端寫死的三個選項（`agents/debate.py` 的
   `DEFAULT_DEBATE_TOPICS`），之後若要開放使用者自訂主題，需要新增對應的
   REST/WS 介面與前端輸入欄位。
9. Agent 波形頭像目前只有「先幫忙 default」的六種預設波形人格原型（見
   第九節），還沒接上真正的問卷流程——`getWaveformSignature()` 已經預留
   `agent.waveform_signature` 覆寫欄位，之後只需要在問卷完成後把算好的
   數值存進這個欄位即可，不需要改動畫元件或波形數學。
