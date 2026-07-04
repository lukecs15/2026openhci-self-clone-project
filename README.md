# 記憶之物 — Drawing to 3D × Self-Dialogue

> 上傳你的畫作，讓它化為立體形體，傾聽它訴說你自己的故事。

## 專案概述

**記憶之物**是一個探索「物品作為自我延伸」的互動裝置。使用者手繪或上傳一張對自己有意義的物品圖像，系統將其轉換為 3D 模型，再透過人格問卷賦予它個性，最終以 LLM 讓這個物品「開口說話」——用你自己的語氣，回應你的傾訴。

**靈感來源：**
- Winnicott (1953)《過渡性客體與過渡現象》：物品作為自我與外部世界之間的媒介
- Turkle (2007)《Evocative Objects》：我們透過物品來思考
- Lacanian 鏡像理論：物品作為「他者」反射自我
- HCI 研究中的 Relational Artifacts（Breazeal, 2002）

---

## 系統架構

```mermaid
flowchart TB
    subgraph Frontend["Frontend (React + Vite)"]
        DC[DrawingCanvas\n繪製 / 上傳圖像]
        MV[ModelViewer\nThree.js 3D 展示]
        PF[PersonalityForm\nBig Five 問卷]
        CI[ChatInterface\n對話 UI]
        Store[Zustand Store\n全域狀態]
    end

    subgraph Backend["Backend (FastAPI)"]
        R1["/api/generate-3d\nimage_to_3d.py"]
        R2["/api/chat\nchat.py"]
        R3["/api/personality/analyze\npersonality.py"]

        MS[MeshyService\nMeshy.ai REST API]
        GS[GeminiService\nGemini API + System Prompt]
        RS[RAGService\nLangChain Stub]
    end

    subgraph External["外部服務"]
        Meshy[(Meshy.ai\nImage-to-3D)]
        Gemini[(Google Gemini\nLLM)]
        TripoSR[(TripoSR\n本地備用 Stub)]
    end

    DC -->|Blob| Store
    Store -->|POST multipart| R1
    R1 --> MS --> Meshy
    MS -->|GLB URL| R1 -->|model_url| Store
    Store --> MV

    PF -->|POST| R3 -->|personality JSON| Store
    Store + CI -->|POST /api/chat| R2
    R2 --> GS --> Gemini
    R2 --> RS
    GS -->|reply| CI

    MS -.->|fallback| TripoSR
```

---

## 環境需求

| 項目 | 版本 |
|------|------|
| Python | 3.10+ |
| Node.js | 18+ |
| npm | 9+ |
| Meshy.ai API Key | [申請](https://www.meshy.ai/) |
| Google Gemini API Key | [申請](https://aistudio.google.com/app/apikey) |

---

## 快速開始

### 1. 複製專案

```bash
git clone <your-repo-url>
cd drawing_to_3d
```

### 2. 設定環境變數

```bash
cp .env.example .env
```

編輯 `.env`，填入：
- `MESHY_API_KEY` — Meshy.ai 金鑰（圖像轉 3D）
- `GEMINI_API_KEY` — Google Gemini 金鑰（LLM 對話）

### 3. 啟動 Backend

```bash
cd backend

# 建立虛擬環境（建議）
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安裝依賴
pip install -r requirements.txt

# 啟動開發伺服器
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Backend 啟動後，API 文件可於 http://localhost:8000/docs 查看。

### 4. 啟動 Frontend

```bash
cd frontend

# 安裝依賴
npm install

# 啟動開發伺服器
npm run dev
```

Frontend 啟動後，開啟 http://localhost:5173 即可使用。

---

## API 文件

### `POST /api/generate-3d`

上傳圖像並轉換為 3D 模型（含等待輪詢）。

**Request：** `multipart/form-data`
| 欄位 | 類型 | 說明 |
|------|------|------|
| `file` | File | PNG / JPEG / WebP，最大 10MB |

**Response：**
```json
{
  "task_id": "string",
  "status": "succeeded",
  "model_url": "https://assets.meshy.ai/xxx.glb",
  "thumbnail_url": "https://assets.meshy.ai/xxx.jpg",
  "progress": 100
}
```

---

### `GET /api/task/{task_id}`

查詢 3D 生成任務狀態（用於前端手動輪詢）。

**Response：** 同上

---

### `POST /api/personality/analyze`

分析 Big Five 問卷並生成物品人格。

**Request：**
```json
{
  "big_five": {
    "openness_1": 4, "openness_2": 3,
    "conscientiousness_1": 4, "conscientiousness_2": 5,
    "extraversion_1": 2, "extraversion_2": 2,
    "agreeableness_1": 5, "agreeableness_2": 4,
    "neuroticism_1": 3, "neuroticism_2": 2
  },
  "object_description": "外婆的茶杯，帶著茉莉花香",
  "self_description": "我是個容易思念過去的人"
}
```

**Response：**
```json
{
  "scores": {
    "openness": 3.5, "conscientiousness": 4.5,
    "extraversion": 2.0, "agreeableness": 4.5, "neuroticism": 2.5
  },
  "personality_summary": "富有創意、好奇心強...",
  "communication_style": "沉靜、深思熟慮；善用比喻...",
  "object_description": "...",
  "self_description": "..."
}
```

---

### `POST /api/chat`

與物品（自我延伸）進行對話。

**Request：**
```json
{
  "message": "你還記得那個下雨天嗎？",
  "session_id": "uuid-string",
  "personality": { ... }
}
```

**Response：**
```json
{
  "reply": "記得。那天你把我握得很緊...",
  "session_id": "uuid-string",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "model", "content": "..." }
  ]
}
```

---

### `GET /api/chat/{session_id}/history`

取得對話歷史。

### `DELETE /api/chat/{session_id}`

清除對話歷史。

### `GET /health`

健康檢查。

---

## 模組說明

### Backend

| 檔案 | 功能 |
|------|------|
| `main.py` | FastAPI 入口，CORS 設定，路由掛載 |
| `config.py` | 環境變數讀取（pydantic-settings） |
| `models/schemas.py` | 所有 API 的 Pydantic 資料模型 |
| `routers/image_to_3d.py` | 圖像轉 3D 路由，含輪詢等待 |
| `routers/chat.py` | LLM 對話路由，session 管理 |
| `routers/personality.py` | 人格分析路由（規則式 Stub） |
| `services/meshy_service.py` | Meshy.ai API 封裝 + TripoSR Stub |
| `services/gemini_service.py` | Gemini API 封裝，system prompt 建構 |
| `services/rag_service.py` | RAG 框架（LangChain Stub，待接入） |

### Frontend

| 檔案 | 功能 |
|------|------|
| `src/App.jsx` | 根組件，路由設定，導航列 |
| `src/main.jsx` | React 入口，全域樣式 |
| `src/pages/DrawingPage.jsx` | 繪圖頁：Canvas + 生成觸發 |
| `src/pages/ModelPage.jsx` | 模型頁：3D 展示 + 人格問卷 |
| `src/pages/ChatPage.jsx` | 對話頁：側邊 3D 預覽 + 聊天 |
| `src/components/DrawingCanvas.jsx` | HTML5 Canvas 繪圖工具 |
| `src/components/ModelViewer.jsx` | Three.js GLB 模型展示，OrbitControls |
| `src/components/PersonalityForm.jsx` | Big Five 問卷 + 人格摘要卡片 |
| `src/components/ChatInterface.jsx` | 對話泡泡 UI，打字動畫 |
| `src/store/useAppStore.js` | Zustand 全域狀態管理 |
| `src/api/client.js` | Axios API 封裝，錯誤處理 |

---

---

## 語音系統設定（v0.2 新增）

### 安裝語音依賴

```bash
cd backend
pip install -r requirements_voice.txt
```

**首次執行注意：**
- **faster-whisper** 會在第一次呼叫 STT 時自動下載模型（medium 約 1.5GB）
- **XTTS v2** 會在第一次合成時自動下載模型（約 2GB），請確保磁碟空間充足
- 下載位置：`~/.cache/tts/`（Coqui TTS 自動管理）

### GTX 1650（4GB VRAM）最佳化建議

| 模型 | VRAM 用量 | 說明 |
|------|-----------|------|
| faster-whisper medium | ~1.5GB | STT，float16 |
| Coqui XTTS v2 | ~2.0GB | TTS，float16 |
| **合計** | **最大 2.0GB**（分時使用） | 程式會在合成前釋放 STT 快取 |

### ⚠ 已知套件衝突

**F5-TTS 與 TripoSR 的 `transformers` 版本衝突。**

F5-TTS 安裝時會將 `transformers` 強制升級至 5.x，導致 TripoSR 的 `ViTModel` import 失敗，3D 生成功能完全停止運作。

因此 v0.2 改用 **Coqui XTTS v2**（`TTS>=0.22.0`），其依賴為 `transformers>=4.33.0`，與 TripoSR 的 `transformers==4.35.0` 完全相容。

**若你之前已安裝過 F5-TTS，請先還原環境：**

```bash
pip uninstall f5-tts torchcodec -y
pip install transformers==4.35.0
pip install -r requirements_voice.txt
```

**VRAM 管理策略：**
- STT 與 TTS 採**分時載入**，不同時在 GPU 上
- 每次模型切換前呼叫 `torch.cuda.empty_cache()`
- 若出現 CUDA OOM，在 `.env` 設定 `TORCH_DTYPE=float32` 改用 CPU（速度較慢）

---

## 聲音克隆流程

### 1. 錄製樣本

前往 `/voice-setup` 頁面，或手動準備 WAV 音訊：
- **格式**：WAV, 16kHz, mono, 16bit
- **時長**：至少 6 秒，建議 15-30 秒（XTTS v2 最低需求 6 秒，越長克隆品質越好）
- **環境**：安靜室內，關閉風扇/冷氣，無背景音樂
- **語言**：繁體中文（STT 以繁中為優先）

**建議朗讀句子（複製使用）：**

> 今天天氣很好，我想起了那段平靜的時光。每一件物品都是記憶的載體，輕聲訴說著那些被遺忘的故事。我把這些記憶珍藏在心裡，等待著某天再次相遇。那把舊椅子、那個破舊的茶杯，它們都見證了我成長的歲月。

### 2. 建立聲音 Profile

透過 `/voice-setup` 頁面 UI 操作，或直接呼叫 API：

```bash
# Step 1: 上傳樣本
curl -X POST http://localhost:8000/api/voice/upload-sample \
  -F "file=@my_voice.wav" \
  -F "object_id=obj-001"

# Step 2: 建立 profile（含調整參數）
curl -X POST http://localhost:8000/api/voice/clone \
  -H "Content-Type: application/json" \
  -d '{
    "object_id": "obj-001",
    "object_name": "外婆的茶杯",
    "pitch_shift": 1.5,
    "speed": 0.95,
    "energy": 0.9,
    "sample_filename": "tmp_obj-001_abc12345.wav"
  }'
```

### 3. 聲音差異化建議

讓多個物件聲音有所區別的參數參考：

| 物件 | pitch_shift | speed | energy | 效果 |
|------|-------------|-------|--------|------|
| 物件 1 | 0.0 | 1.0 | 1.0 | 原聲（基準） |
| 物件 2 | +1.5 | 0.95 | 0.9 | 稍高音、輕柔 |
| 物件 3 | -1.5 | 1.05 | 1.1 | 稍低音、有力 |
| 物件 4 | +2.5 | 0.9 | 0.85 | 高音、輕柔慢速 |

---

## 場景操作說明

### 進入語音場景

1. 完成繪圖、3D 模型生成、人格問卷
2. 點選「聲音設定」上傳錄音樣本（可跳過，但無語音輸出）
3. 點選「✦ 語音場景」進入對話

### 對話流程

1. **自我介紹（Phase 1）**：物件依序出現並自我介紹，各提出一個引發反思的問題
2. **對話（Phase 2）**：固定輪流，使用者說話 → 所有物件依序回應
3. **結束**：10 次來回後，底部出現「結束對話」按鈕

### 語音輸入

| 模式 | 操作 | 說明 |
|------|------|------|
| 按住說話（Push-to-talk） | 按住麥克風按鈕 → 放開傳送 | 預設模式 |
| 點按切換（Toggle） | 點一次開始 → 再點一次停止 | 點選「按住/點按」切換 |
| 文字輸入 | 點選 ✏ 展開輸入欄 | 無法使用麥克風時的備用 |

### 場景切換

- 右上角按鈕切換「空間感」↔「抽象浮空」模式
- 空間感：有地板、霧氣、方向性燈光
- 抽象浮空：純黑底、星空粒子、無地板

---

## 未來擴展

### 接入 TripoSR 本地端

1. 安裝：`pip install git+https://github.com/VAST-AI-Research/TripoSR.git`
2. 在 `services/meshy_service.py` 的 `LocalModel3DService` 實作 `_run_triposr()` 方法
3. 將輸出的 `.glb` 掛載為 FastAPI 靜態路由：
   ```python
   app.mount("/models", StaticFiles(directory="outputs"), name="models")
   ```
4. 在 `.env` 設定 `USE_LOCAL_MODEL_FALLBACK=true` 並指定 `LOCAL_MODEL_WEIGHTS_PATH`

### 為 RAG 加入文件來源

1. 在 `services/rag_service.py` 實作 `index_documents()`
2. 文件來源選項：使用者日記、物品故事、心理學文本
3. 向量資料庫選擇：
   - 本地：ChromaDB（已在 requirements.txt）
   - 雲端：Pinecone（`pip install pinecone-client`）
4. Chat router 中 `rag_service.retrieve()` 會自動啟用

### 替換人格分析模組

1. 將 `routers/personality.py` 的 `_compute_personality_summary()` 替換為 LLM 呼叫
2. 接入 LIWC（語言詢問與詞語計數）進行文字風格分析
3. 多模態分析：結合畫作視覺特徵（顏色、筆觸）判斷情緒

### 移植到 VR（WebXR）

1. 在 `ModelViewer.jsx` 加入 `@react-three/xr`：
   ```jsx
   import { VRButton, XR } from '@react-three/xr'
   ```
2. 將 Canvas 包裹在 `<XR>` 中啟用 WebXR
3. 加入手部追蹤（hand tracking）讓使用者「觸碰」物品
4. 對話改為語音介面（Web Speech API 或 ElevenLabs TTS）

---

## License

MIT
