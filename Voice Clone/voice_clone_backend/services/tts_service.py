"""
services/tts_service.py — CosyVoice 2 串流 TTS 服務封裝

對照架構文件 2.4 節：
    - CosyVoice 2 非 Pipecat 內建的 TTS 服務，需自己包一層 custom TTS service class
    - 建議把 Pipecat worker process 跟 CosyVoice 2 服務放在同一台 RTX 5090 機器上，
      讓「音訊生成」是 localhost 內部呼叫，只有「LLM 文字 token」需要真的往返雲端網路
    - CosyVoice 2 本身不是台灣腔專用模型，精準台灣腔需額外用台灣腔語料微調
      （見 config.py 的 cosyvoice_taiwan_lora_path，目前尚未訓練，留空使用官方權重）

使用者聲音克隆（見 services/voice_profile_service.py）：
    - 使用者上傳一段音訊 → 建立 VoiceProfile（含自動轉錄的逐字稿）
    - agent 的 AgentConfig.voice_profile_id 指到某個 profile，
      本檔案的 resolve_voice_profile() 負責把 id 換成實際的參考音訊路徑 + 逐字稿
    - CosyVoice 2 走 zero-shot 克隆，不需要另外訓練，載入參考音訊當下就能用

架構：
    CosyVoiceServer（獨立常駐行程，本檔案下方的 CosyVoiceModelServer）
        - 常駐載入 CosyVoice 2 權重，避免每次呼叫重新載入
        - 對外提供 WebSocket streaming 合成介面（文字進、音訊 chunk 串流出）
    CosyVoiceTTSService（Pipecat pipeline 內使用的 client 端封裝）
        - 透過 WebSocket 呼叫上面的常駐服務，屬於 localhost 內部呼叫
    MockTTSService
        - 開發機（GTX 1660 Ti）VRAM 不足以流暢跑 CosyVoice 2 時的替代品，
          只驗證管線協定（文字 → 假音訊 bytes），不需要任何模型權重

使用方式（於 pipeline 中）：
    tts = get_tts_service()
    async for chunk in tts.synthesize(agent_id, sentence, voice_profile_id):
        await websocket.send(chunk.audio_bytes)
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path
from typing import AsyncIterator, Optional, Protocol, Tuple

from config import get_settings
from models.schemas import TTSAudioChunk

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# CosyVoice 官方 repo 路徑（原始碼形式 vendor 在 voice_clone_backend/CosyVoice，
# 非 pip 套件，需自行加進 sys.path 才能 `import cosyvoice`）
# ─────────────────────────────────────────────────────────────────────────────

_COSYVOICE_REPO_DIR = Path(__file__).resolve().parent.parent / "CosyVoice"
_MATCHA_TTS_DIR = _COSYVOICE_REPO_DIR / "third_party" / "Matcha-TTS"
_DEFAULT_PROMPT_WAV = _COSYVOICE_REPO_DIR / "asset" / "zero_shot_prompt.wav"
_DEFAULT_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"

# CosyVoice3（settings.cosyvoice_model_version == "cosyvoice3"）的
# CosyVoice3LM.inference() 內部會 assert prompt_text 或 text 裡一定要出現
# <|endofprompt|>（token id 151646），沒有會直接丟例外，見官方
# CosyVoice/example.py 的 cosyvoice3_example()。這個前綴會在
# CosyVoiceModelServer.synthesize_stream() 裡自動補到 prompt_text 前面
# （不管 prompt_text 是預設音色還是使用者上傳的克隆聲音），呼叫端不需要
# 自己記得加。
_COSYVOICE3_ENDOFPROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"


def _ensure_cosyvoice_importable() -> None:
    """把 CosyVoice repo 與其內附的 Matcha-TTS 子模組加進 sys.path。

    CosyVoice 2 的 flow / hifigan 模組會 `import matcha...`（third_party/
    Matcha-TTS 子模組），兩個路徑都要在 `import cosyvoice` 之前加進
    sys.path，否則會直接 ImportError。
    """
    for path in (_COSYVOICE_REPO_DIR, _MATCHA_TTS_DIR):
        path_str = str(path)
        if path.exists() and path_str not in sys.path:
            sys.path.insert(0, path_str)


def _patch_cosyvoice_load_wav() -> None:
    """
    把 CosyVoice 官方 cosyvoice.cli.frontend.load_wav 換成不依賴 torchcodec 的版本。

    修過的真實問題：官方 load_wav() 呼叫
    `torchaudio.load(wav, backend='soundfile')`，較新版 torchaudio（本專案
    prod 環境安裝的 2.7+）這個路徑會轉呼叫內部的 load_with_torchcodec()，
    需要另外安裝 torchcodec 套件（還要跟 torch/CUDA 版本對得上，容易變成
    另一個相依性地獄），沒裝就直接 ModuleNotFoundError，導致每一次
    zero-shot 合成（讀取參考音訊那一步）都失敗。改用 soundfile 直接讀
    （讀不動的格式如 m4a/mp3 才 fallback 到 PyAV），兩者都完全不需要
    torchcodec，也是 STT 那邊（services/stt_service.py 的 _decode_with_pyav）
    已經驗證過可行的解碼路徑。

    注意：`cosyvoice.cli.frontend` 是用
    `from cosyvoice.utils.file_utils import load_wav` 把它綁進自己模組的
    全域命名空間，所以要直接覆寫 `cosyvoice.cli.frontend.load_wav` 這個
    屬性（而不是 `cosyvoice.utils.file_utils.load_wav`）才會真的生效——
    frontend.py 呼叫 load_wav(...) 時，是在自己模組的全域命名空間查找這個
    名字，跟這個名字原本是從哪裡 import 進來的無關。
    """
    import cosyvoice.cli.frontend as _cv_frontend

    if getattr(_cv_frontend.load_wav, "_is_no_torchcodec_patch", False):
        return  # 已經 patch 過（例如重複呼叫 _load()），避免重複記 log

    def _load_wav_no_torchcodec(wav_path, target_sr, min_sr=16000):
        import numpy as np
        import soundfile as sf
        import torch
        import torchaudio

        try:
            audio_np, sr = sf.read(wav_path, dtype="float32", always_2d=True)
            audio_np = audio_np.T  # soundfile 回傳 (samples, channels)，轉成 (channels, samples)
        except Exception as exc:  # noqa: BLE001 — soundfile 對不支援的格式會直接拋例外
            logger.info("soundfile 無法解析參考音訊（%s），改用 PyAV 解碼", exc)
            import av

            container = av.open(wav_path)
            try:
                stream = container.streams.audio[0]
                sr = stream.rate or target_sr
                resampler = av.AudioResampler(format="fltp", layout="mono", rate=sr)
                chunks = []
                for frame in container.decode(stream):
                    for resampled in resampler.resample(frame):
                        chunks.append(resampled.to_ndarray())
                for resampled in resampler.resample(None):
                    chunks.append(resampled.to_ndarray())
            finally:
                container.close()
            if not chunks:
                raise RuntimeError(f"PyAV 未能從 {wav_path} 解出任何音訊 frame")
            audio_np = np.concatenate(chunks, axis=1)

        speech = torch.from_numpy(np.ascontiguousarray(audio_np, dtype=np.float32))
        speech = speech.mean(dim=0, keepdim=True)

        if sr != target_sr:
            if sr < min_sr:
                raise AssertionError(f"wav sample rate {sr} must be greater than {min_sr}")
            speech = torchaudio.transforms.Resample(orig_freq=sr, new_freq=target_sr)(speech)
        return speech

    _load_wav_no_torchcodec._is_no_torchcodec_patch = True
    _cv_frontend.load_wav = _load_wav_no_torchcodec
    logger.info("已將 cosyvoice.cli.frontend.load_wav 替換成不依賴 torchcodec 的版本")


def _patch_cosyvoice_attn_implementation() -> None:
    """
    強制 CosyVoice 2 LLM 內部的 Qwen2ForCausalLM 使用 eager attention（不透過 SDPA）。

    修過的真實問題：即使完全繞過本專案包裝層、直接照抄 CosyVoice 官方
    example.py 的呼叫方式（scripts/diagnose_cosyvoice_official.py），拿
    官方預設參考音色（asset/zero_shot_prompt.wav + 官方逐字稿）合成，
    使用者實測回報出來的語音仍然會不斷重複少數幾個音節。這排除了本專案
    自訂的 prompt_text/PCM 轉換/WebSocket 包裝層，把範圍縮到「環境本身」。

    載入權重時 transformers 會印出這行警告：
        Sliding Window Attention is enabled but not implemented for `sdpa`;
        unexpected results may be encountered.
    這代表 cosyvoice/llm/llm.py 的 Qwen2Encoder 用
    `Qwen2ForCausalLM.from_pretrained(pretrain_path)` 載入的 base LM
    config 裡帶了 sliding_window 設定，但目前 transformers 版本自動選用的
    attn_implementation='sdpa' 並沒有正確實作 sliding window 遮罩——官方
    自己在警告裡就明講「unexpected results may be encountered」。

    這跟症狀完全對得上：CosyVoice 這顆 LLM 是用 forward_one_step /
    forward_chunk 手動管理 KV cache、逐一 token 自迴歸生成語音 token
    （不是走 transformers 的 generate()），對每一步的注意力遮罩正確性非常
    敏感。遮罩算錯，最直接的症狀就是模型不斷被自己前面生成過的 token
    「拉回去」，退化成重複輸出同一個（或少數幾個）token——正是使用者
    實測聽到的「重複音節」。

    CosyVoice 官方測試環境是 torch==2.3.1，這裡的 RTX 5090（Blackwell）
    環境因為硬體限制被迫用更新的 torch（實測 2.11.0+cu128），沒辦法回退
    成官方版本去複現官方當初 SDPA 的行為；改用 eager attention（不透過
    SDPA）繞開這個已知限制，是不依賴特定 torch/transformers 版本組合、
    最直接可靠的修法。

    注意：這個 patch 必須在 `CosyVoice2(model_dir, ...)` 建構之前呼叫，
    因為 Qwen2Encoder 是 cosyvoice2.yaml 由 hyperpyyaml 在建構當下就
    `!new:cosyvoice.llm.llm.Qwen2Encoder` 直接 instantiate 完成的，
    不像 load_wav 是等到真正推理時才會被呼叫到。
    """
    import cosyvoice.llm.llm as _cv_llm

    if getattr(_cv_llm.Qwen2Encoder.__init__, "_is_eager_attn_patch", False):
        return

    import torch
    from transformers import Qwen2ForCausalLM

    def _patched_init(self, pretrain_path):
        torch.nn.Module.__init__(self)
        self.model = Qwen2ForCausalLM.from_pretrained(pretrain_path, attn_implementation="eager")

    _patched_init._is_eager_attn_patch = True
    _cv_llm.Qwen2Encoder.__init__ = _patched_init
    logger.info(
        "已將 CosyVoice 2 LLM 的 Qwen2ForCausalLM 強制改用 eager attention"
        "（避開目前 transformers 版本 SDPA 對 sliding window 的已知限制）"
    )


def _patch_cosyvoice_forward_one_step_position_ids() -> None:
    """
    修正 Qwen2Encoder.forward_one_step() 逐 token 解碼時沒有明確指定
    position_ids，改成用 KV cache 目前實際長度算出正確的 position_ids。

    修過的真實問題：改用 eager attention 之後（見
    `_patch_cosyvoice_attn_implementation`），使用者實測回報 zero-shot
    合成「面對失敗，重點只有兩個字：止損」還是聽起來錯誤。改用
    `inference_vc()`（voice conversion，完全跳過 LLM、直接用真人語音的
    真實 speech token 走 flow+hift）自我重建同一個官方參考音檔，輸出的
    語音卻完全正確——這決定性地把問題範圍從「flow/hift/特徵抽取」全部
    排除，鎖定在 LLM 逐 token 自迴歸生成這一段本身。同時，token 統計顯示
    生成的語音 token 種類夠多、沒有卡死在單一 token 上，所以也不是最粗暴
    的那種「重複 loop」——比較像是「每一步生成的 token 有效但内容不對」，
    這種症狀最典型的成因是「模型在解碼時搞錯自己現在是第幾個 token」。

    官方 `cosyvoice/llm/llm.py` 的 `Qwen2Encoder.forward_one_step()` 原始
    實作：
        def forward_one_step(self, xs, masks, cache=None):
            input_masks = masks[:, -1, :]
            outs = self.model(inputs_embeds=xs, attention_mask=input_masks,
                              output_hidden_states=True, return_dict=True,
                              use_cache=True, past_key_values=cache)
            ...
    第一步（cache=None）xs 是完整 prompt 序列、input_masks 長度跟 xs 一致，
    沒有問題。但從第二步開始，`cache` 已經帶有前面所有 token 的 KV，
    這一步的 `xs` 卻只有「新的這一個 token」（shape (1, 1, hidden)），
    `input_masks` 也只有形狀 (1, 1)——完全沒有告訴 transformers「這個新
    token 其實是序列裡的第 N 個」。沒有明確傳 position_ids/cache_position
    時，transformers 得自己用內部邏輯去猜正確位置；這段邏輯在不同
    torch/transformers 版本組合下並不保證行為一致（尤其牽扯到
    DynamicCache／SDPA／eager 各自準備 4D mask 的內部實作），猜錯位置的
    後果就是模型在每一步都「以為自己在講前面幾個字」，生成出來的 token
    因此有效但答非所問——跟使用者實測聽到的「聽起來錯誤」完全吻合，也
    跟「token 種類正常、不是卡死重複」的統計結果吻合。

    這裡直接用 cache 目前的實際長度算出正確的 position_ids，明確傳給
    `self.model(...)`，不依賴 transformers 對「短 attention_mask + 長
    cache」這個少見組合的內部猜測邏輯，不管裝哪個 transformers/torch
    版本組合都應該要正確。
    """
    import cosyvoice.llm.llm as _cv_llm

    if getattr(_cv_llm.Qwen2Encoder.forward_one_step, "_is_position_ids_patch", False):
        return

    import torch

    def _patched_forward_one_step(self, xs, masks, cache=None):
        input_masks = masks[:, -1, :]

        past_length = 0
        if cache is not None:
            if hasattr(cache, "get_seq_length"):
                past_length = cache.get_seq_length()
            elif len(cache) > 0:
                # legacy tuple-of-tuples cache 格式：(key, value)，
                # key shape 通常是 (batch, num_heads, seq_len, head_dim)
                past_length = cache[0][0].shape[2]

        seq_len = xs.shape[1]
        position_ids = torch.arange(
            past_length, past_length + seq_len, dtype=torch.long, device=xs.device
        ).unsqueeze(0)

        outs = self.model(
            inputs_embeds=xs,
            attention_mask=input_masks,
            position_ids=position_ids,
            output_hidden_states=True,
            return_dict=True,
            use_cache=True,
            past_key_values=cache,
        )
        xs = outs.hidden_states[-1]
        new_cache = outs.past_key_values
        return xs, new_cache

    _patched_forward_one_step._is_position_ids_patch = True
    _cv_llm.Qwen2Encoder.forward_one_step = _patched_forward_one_step
    logger.info(
        "已修正 CosyVoice 2 LLM 逐 token 解碼時的 position_ids 計算"
        "（避免 transformers 對短 attention_mask + KV cache 的位置推斷不穩定）"
    )


def _tts_speech_to_pcm16_bytes(tts_speech) -> bytes:
    """把 CosyVoice 2 輸出的 float32 波形 tensor 轉成 16-bit PCM bytes。

    與 MockTTSService／既有前端播放佇列約定的格式一致（16-bit PCM，見
    stt_service.py decode_audio_bytes_to_mono_float32 的反向操作）。
    """
    import numpy as np

    audio_np = tts_speech.detach().to("cpu").float().numpy().reshape(-1)
    audio_np = np.clip(audio_np, -1.0, 1.0)
    return (audio_np * 32767.0).astype(np.int16).tobytes()


class TTSService(Protocol):
    async def synthesize(
        self, agent_id: str, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[TTSAudioChunk]:
        ...


# ─────────────────────────────────────────────────────────────────────────────
# CosyVoice（2 或 3，見 config.py 的 cosyvoice_model_version）
# — 常駐模型服務（跑在 RTX 5090 上的獨立行程）
# ─────────────────────────────────────────────────────────────────────────────

class CosyVoiceModelServer:
    """
    CosyVoice 常駐模型服務，依 settings.cosyvoice_model_version 載入
    CosyVoice2 或 CosyVoice3（預設 cosyvoice3，見 _load() 註解說明原因）。

    建議獨立啟動為一個 process（例如 `python -m services.cosyvoice_server`），
    Pipecat worker 透過 WebSocket 呼叫它，兩者在同一台機器上以 localhost 溝通，
    避免每次合成都重新載入權重（CosyVoice 權重載入通常需要數秒）。

    正式整合（見本檔案上方 _ensure_cosyvoice_importable / _tts_speech_to_pcm16_bytes）：
        from cosyvoice.cli.cosyvoice import CosyVoice2  # 或 CosyVoice3
        self._model = CosyVoice2(model_dir, load_jit=False, load_trt=False, fp16=True)
        for chunk in self._model.inference_zero_shot(text, prompt_text, prompt_speech, stream=True):
            yield chunk['tts_speech']

    注意：
        - frontend_zero_shot() 內部會自己呼叫官方 load_wav() 讀取音檔，
          所以這裡直接傳「參考音訊的檔案路徑字串」即可，不需要自己先讀成
          tensor。
        - CosyVoice3 額外要求 prompt_text 裡要有 <|endofprompt|> 標記，
          見 synthesize_stream() 裡對 _COSYVOICE3_ENDOFPROMPT_PREFIX 的
          處理，呼叫端不需要自己記得加。
    """

    def __init__(self):
        self._model = None
        settings = get_settings()
        self._model_path = settings.cosyvoice_model_path
        self._model_version = settings.cosyvoice_model_version
        self._taiwan_lora_path = settings.cosyvoice_taiwan_lora_path

    def _load(self):
        if self._model is not None:
            return self._model
        if not self._model_path:
            raise RuntimeError(
                "COSYVOICE_MODEL_PATH 未設定，請先下載 CosyVoice 權重並設定路徑。"
            )

        _ensure_cosyvoice_importable()

        _patch_cosyvoice_load_wav()
        # 必須在 CosyVoice2(...)/CosyVoice3(...) 建構之前呼叫，見函式
        # docstring：Qwen2Encoder 是 hyperpyyaml 載入 cosyvoice2.yaml/
        # cosyvoice3.yaml 當下就直接 instantiate 的，CosyVoice2 跟
        # CosyVoice3 的 LLM 底層都是同一個 cosyvoice.llm.llm.Qwen2Encoder
        # 類別，這兩個 patch 對兩者都適用。
        _patch_cosyvoice_attn_implementation()
        _patch_cosyvoice_forward_one_step_position_ids()

        settings = get_settings()
        # Blackwell（RTX 5090）對 bfloat16 有原生加速，但 CosyVoice 建構子的
        # fp16 參數只接受 bool；只要不是 CPU/float32 profile 就啟用半精度推理。
        use_fp16 = settings.torch_device == "cuda" and settings.torch_dtype != "float32"

        # 修過的真實問題：CosyVoice2-0.5B 在這台 RTX 5090（Blackwell）+
        # torch 2.11 環境下，zero-shot 合成中文語音內容會嚴重跑掉（不是
        # 退化重複，是 LLM 生成的語音 token 內容本身不對，token 分布統計
        # 正常）。逐一排除套件版本、attention 實作、position_ids、詞彙表
        # 大小、tokenizer 正確性、fp16、TF32 等變因都沒解決，改用架構較新
        # 的官方權重 CosyVoice3（Fun-CosyVoice3-0.5B）後實測品質正常，
        # 因此預設改用 cosyvoice3（見 config.py 的 cosyvoice_model_version）。
        # 兩者的建構子簽名不同（CosyVoice3 沒有 load_jit 參數）。
        if self._model_version == "cosyvoice3":
            from cosyvoice.cli.cosyvoice import CosyVoice3

            logger.info("載入 CosyVoice3 權重中：%s（fp16=%s）…", self._model_path, use_fp16)
            self._model = CosyVoice3(self._model_path, load_trt=False, fp16=use_fp16)
            logger.info("CosyVoice3 載入完成，sample_rate=%d", self._model.sample_rate)
        else:
            from cosyvoice.cli.cosyvoice import CosyVoice2

            logger.info("載入 CosyVoice2 權重中：%s（fp16=%s）…", self._model_path, use_fp16)
            self._model = CosyVoice2(
                self._model_path, load_jit=False, load_trt=False, fp16=use_fp16
            )
            logger.info("CosyVoice2 載入完成，sample_rate=%d", self._model.sample_rate)

        if self._taiwan_lora_path:
            logger.warning(
                "COSYVOICE_TAIWAN_LORA_PATH 已設定（%s），但台灣腔 LoRA 掛載邏輯尚未"
                "實作（見 README「未來擴展」），目前仍使用官方權重推理。",
                self._taiwan_lora_path,
            )
        return self._model

    def _default_prompt(self) -> Tuple[str, str]:
        """沒有指定 voice_profile_id（或 profile 缺 reference_text）時使用的預設官方音色。"""
        settings = get_settings()
        prompt_wav = settings.cosyvoice_default_prompt_wav or str(_DEFAULT_PROMPT_WAV)
        prompt_text = settings.cosyvoice_default_prompt_text or _DEFAULT_PROMPT_TEXT
        return prompt_wav, prompt_text

    async def synthesize_stream(
        self, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[bytes]:
        """
        依 voice_profile_id 解析出使用者的克隆聲音，做 zero-shot 串流合成。

        voice_profile_id 對應到 services/voice_profile_service.py 建立的
        VoiceProfile（使用者上傳音訊後產生），內含：
            - reference_audio_path：使用者上傳的參考音訊
            - reference_text      ：該音訊的逐字稿（自動轉錄或使用者手動輸入）
        兩者就是 CosyVoice 2 zero-shot 克隆 inference_zero_shot() 需要的
        prompt_speech_16k / prompt_text；沒有指定 voice_profile_id，或 profile
        存在但沒有 reference_text（例如自動轉錄失敗），則改用預設官方音色
        （見 _default_prompt()）做 zero-shot 合成，而不是整段請求失敗。
        """
        loop = asyncio.get_event_loop()
        model = await loop.run_in_executor(None, self._load)

        profile = resolve_voice_profile(voice_profile_id) if voice_profile_id else None
        if voice_profile_id and profile is None:
            logger.warning(
                "找不到 voice_profile_id=%s 對應的克隆聲音 profile，改用預設音色", voice_profile_id
            )

        if profile is not None and profile.reference_text and profile.reference_audio_path:
            prompt_wav, prompt_text = profile.reference_audio_path, profile.reference_text
        else:
            if profile is not None:
                logger.warning(
                    "voice_profile_id=%s 的 profile 缺少 reference_text（可能自動轉錄"
                    "失敗），改用預設官方音色", voice_profile_id,
                )
            prompt_wav, prompt_text = self._default_prompt()

        if self._model_version == "cosyvoice3" and _COSYVOICE3_ENDOFPROMPT_PREFIX not in prompt_text:
            # CosyVoice3LM.inference() 會 assert prompt_text/text 裡一定要有
            # <|endofprompt|>，不管 prompt_text 是預設音色還是使用者上傳的
            # 克隆聲音逐字稿，這裡統一補上，呼叫端／使用者不需要自己記得加。
            prompt_text = _COSYVOICE3_ENDOFPROMPT_PREFIX + prompt_text

        # inference_zero_shot() 是同步（CPU/GPU-bound）generator，丟到背景執行緒
        # 跑，透過 asyncio.Queue 把每個 chunk 轉回 event loop 端，讓外層仍能維持
        # async generator 介面、逐 chunk 邊生成邊透過 WebSocket 送出。
        #
        # 修過的真實問題：這裡以前不管推理成功或失敗都只會 log 一下就把
        # 例外吞掉，讓 async generator「正常結束」（0 個 chunk），呼叫端
        # （cosyvoice_server.py → CosyVoiceTTSService → agents/debate.py）
        # 完全看不出這句話合成失敗了，跟「這句話本來就是空白」無法區分。
        # 辯論模式因此出現使用者實測回報過的真實問題：TTS 一路失敗，但
        # 因為每輪「預估播放時長」都算出 0（沒有任何音訊資料），節奏控制
        # 形同虛設，兩位 agent 完全沒有停頓地飛快輪流講下去。現在推理失敗
        # 會把例外物件放進 queue，讓下面的迴圈真的 raise 出去，呼叫端才有
        # 機會接住並做「保留文字、改用文字長度估計節奏」這種優雅降級
        # （見 agents/debate.py、agents/orchestrator.py 的 _synthesize_and_wrap）。
        queue: "asyncio.Queue[Optional[bytes] | Exception]" = asyncio.Queue()

        def _produce() -> None:
            try:
                for model_output in model.inference_zero_shot(
                    text, prompt_text, prompt_wav, stream=True
                ):
                    pcm_bytes = _tts_speech_to_pcm16_bytes(model_output["tts_speech"])
                    loop.call_soon_threadsafe(queue.put_nowait, pcm_bytes)
            except Exception as exc:  # noqa: BLE001
                logger.exception("CosyVoice 2 推理失敗（text=%s）", text[:50])
                loop.call_soon_threadsafe(queue.put_nowait, exc)
                return
            loop.call_soon_threadsafe(queue.put_nowait, None)

        loop.run_in_executor(None, _produce)

        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise RuntimeError(f"CosyVoice 2 合成失敗：{item}") from item
            yield item


def resolve_voice_profile(voice_profile_id: str):
    """查詢 voice_profile_service，取得 voice_profile_id 對應的 VoiceProfile（找不到回傳 None）。"""
    from services.voice_profile_service import get_voice_profile_service

    return get_voice_profile_service().get_profile(voice_profile_id)


# ─────────────────────────────────────────────────────────────────────────────
# CosyVoiceTTSService — Pipecat pipeline 內的 client 端封裝
# ─────────────────────────────────────────────────────────────────────────────

class CosyVoiceTTSService:
    """
    透過 WebSocket 呼叫本地常駐的 CosyVoiceModelServer（或獨立行程）。

    這一層對應架構文件裡「非 Pipecat 內建 TTS，需要自己包一層 custom TTS
    service class」的需求，也是實際掛進 Pipecat pipeline（見 pipeline/
    conversation_pipeline.py）的物件。
    """

    def __init__(self, host: Optional[str] = None, port: Optional[int] = None):
        settings = get_settings()
        self._host = host or settings.cosyvoice_server_host
        self._port = port or settings.cosyvoice_server_port

    async def synthesize(
        self, agent_id: str, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[TTSAudioChunk]:
        import json

        import websockets

        uri = f"ws://{self._host}:{self._port}/synthesize"
        start = time.perf_counter()
        first_chunk = True

        async with websockets.connect(uri) as ws:
            await ws.send(
                _encode_request(text=text, voice_profile_id=voice_profile_id)
            )
            async for raw in ws:
                # 伺服器合成失敗時會送一個 JSON text frame 回報錯誤（見
                # cosyvoice_server.py 的 _handle_connection），不是音訊資料。
                # websockets 套件會保留 text/binary frame 的區別：ws.send(str)
                # 送出的文字 frame 這裡收到時型別是 str，音訊 binary frame
                # 收到時型別是 bytes，可以直接用型別分辨兩者。
                if isinstance(raw, str):
                    try:
                        err_message = json.loads(raw).get("error", raw)
                    except json.JSONDecodeError:
                        err_message = raw
                    raise RuntimeError(f"CosyVoice 2 合成失敗：{err_message}")

                ttfb = None
                if first_chunk:
                    ttfb = (time.perf_counter() - start) * 1000
                    first_chunk = False
                yield TTSAudioChunk(agent_id=agent_id, audio_bytes=raw, ttfb_ms=ttfb)

        yield TTSAudioChunk(agent_id=agent_id, audio_bytes=b"", is_final=True)


def _encode_request(text: str, voice_profile_id: str) -> bytes:
    import json

    return json.dumps({"text": text, "voice_profile_id": voice_profile_id}).encode("utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# MockTTSService — 開發機 / CI 使用，不需要任何模型權重
# ─────────────────────────────────────────────────────────────────────────────

class MockTTSService:
    """
    不載入 CosyVoice 2，直接依文字長度產生假音訊 bytes（靜音 PCM），
    用來驗證「pipeline 組裝 → WebSocket 串流 → 前端播放佇列」整條管線，
    在 GTX 1660 Ti 這種 VRAM 有限的開發機上完全不需要 GPU。

    也會模擬「串流分 chunk」的行為（每 chunk 對應約 0.5 秒音訊），
    讓上層程式碼（例如前端播放佇列）可以用同樣的邏輯處理 mock 與真實資料。

    雖然不做真的聲音克隆，仍會呼叫 resolve_voice_profile() 查詢 voice_profile_id
    是否存在，並記錄在 last_resolved_profile，方便測試斷言「有沒有正確查到
    使用者上傳的克隆聲音 profile」，之後換成 CosyVoiceTTSService 時這段查詢
    邏輯不需要改。
    """

    def __init__(self, sample_rate: int = 24000, chunk_seconds: float = 0.5):
        self._sample_rate = sample_rate
        self._chunk_seconds = chunk_seconds
        self.last_resolved_profile = None

    async def synthesize(
        self, agent_id: str, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[TTSAudioChunk]:
        self.last_resolved_profile = (
            resolve_voice_profile(voice_profile_id) if voice_profile_id else None
        )
        if voice_profile_id and self.last_resolved_profile is None:
            logger.warning("MockTTSService 找不到 voice_profile_id=%s", voice_profile_id)

        start = time.perf_counter()
        # 粗略估計：中文每字約 0.2 秒發音時間
        estimated_seconds = max(len(text) * 0.2, self._chunk_seconds)
        n_chunks = max(1, int(estimated_seconds / self._chunk_seconds))
        samples_per_chunk = int(self._sample_rate * self._chunk_seconds)
        silence_chunk = b"\x00\x00" * samples_per_chunk  # 16-bit PCM 靜音

        for i in range(n_chunks):
            await asyncio.sleep(0)  # 模擬串流節奏但不拖慢測試
            ttfb = (time.perf_counter() - start) * 1000 if i == 0 else None
            yield TTSAudioChunk(
                agent_id=agent_id,
                audio_bytes=silence_chunk,
                sample_rate=self._sample_rate,
                ttfb_ms=ttfb,
            )

        yield TTSAudioChunk(agent_id=agent_id, audio_bytes=b"", is_final=True)


# ─────────────────────────────────────────────────────────────────────────────
# Factory
# ─────────────────────────────────────────────────────────────────────────────

_tts_service_singleton: Optional[TTSService] = None


def get_tts_service() -> TTSService:
    """依 config 的 tts_engine 設定回傳對應的 TTS 服務單例。"""
    global _tts_service_singleton
    if _tts_service_singleton is None:
        settings = get_settings()
        if settings.tts_engine == "cosyvoice2":
            _tts_service_singleton = CosyVoiceTTSService()
        else:
            _tts_service_singleton = MockTTSService()
    return _tts_service_singleton
