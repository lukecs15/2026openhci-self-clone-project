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
