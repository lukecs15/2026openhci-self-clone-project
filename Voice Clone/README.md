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
    - 使用者訊息提到某個 agent 的名字 → 只由該 agent 回應。
    - 沒有指名 → **全體依序輪流各自回應一次**（像小組討論：使用者說一句話，
      agent A 先完整回完、接著 B、再來 C，不是平行同時講）。這是預設行為。
- **Job Group**（`agents/job_group.py`）：平行分派給多個 agent「同時」處理，
  適合辯論 / 多角色討論情境（`should_use_job_group()` 偵測訊息是否包含
  「大家」「所有人」「辯論」等關鍵字，觸發時才會走這條路）。

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

54 個測試，涵蓋範圍：STT 主備切換（逾時/例外/正常，含「primary 與 fallback
都逾時」的迴歸測試）、音訊解碼（WAV 直接解、非 WAV 容器 fallback 到 pydub）、
LLM 逐句斷句（SentenceAggregator 各種邊界情況）、Handoff 決策（指名單一 agent /
沒指名時全體依序輪流 / LLM tool-call 模擬）、Job Group（平行分派、單一 agent
失敗隔離、max_concurrency 限制）、Orchestrator 端到端事件流（handoff 序列、
job_group 平行、agent_speaking_chunk 文字不重複的迴歸測試）、pipeline 組裝層
（`build_test_conversation_session`、LLM mock/real 自動判斷邏輯）、使用者聲音
克隆 profile 的上傳/建立/查詢/刪除、自動轉錄逐字稿、以及 TTS 服務正確查到
指派給 agent 的克隆聲音 profile。

### 前端（vitest，純邏輯測試，無需啟動瀏覽器）

```bash
cd voice_clone_frontend
npm install
npm test
```

22 個測試，涵蓋範圍：`agentSessionReducer` 狀態機（session_ready / user_transcript /
routing_decision / agent_speaking_start·chunk·end / error / disconnected 等
WebSocket 事件如何驅動 UI 狀態，含多 agent 同時發話情境、以及「chunk 文字為空
不重複記錄 transcript」的迴歸測試）、`applyVoiceProfileToAgents` /
`clearVoiceProfileFromAgents`（套用到單一 agent、套用到全部 agent、不可變性、
找不到 target 時的行為）、`sendQueue`（WebSocket 連線還沒 OPEN 時的訊息佇列，
修過的 init_session 遺失 bug）。

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

聲音克隆 profile 走一般 REST（見上方第四節），不透過 WebSocket。

## 八、尚待整合（對照原架構文件「尚待討論」章節）

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
4. VAD / turn-detection（目前假設前端已完成語音斷句才送出 `user_audio`）
5. 傳輸層：目前用自架 WebSocket，架構文件提及 Daily / LiveKit WebRTC 為
   後續可選傳輸層（`config.py` 的 `transport` 欄位已預留）
6. 延遲實測：STT → LLM → TTS 各段真實延遲，需在 RTX 5090 上實測
7. 音訊品質驗證（`routers/voice_profiles.py` 目前沒有檢查上傳樣本的時長/SNR）
