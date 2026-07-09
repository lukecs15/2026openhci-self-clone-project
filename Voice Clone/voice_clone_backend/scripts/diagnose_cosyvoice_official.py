"""
scripts/diagnose_cosyvoice_official.py — 完全繞過本專案包裝層的 CosyVoice 2 診斷腳本

存在的理由：使用者實測回報 zero-shot 合成出來的聲音會不斷重複少數幾個音節
（例如「我我我我我喔我喔喔喔喔」），懷疑是正式環境（RTX 5090）套件版本跟
CosyVoice 官方 requirements.txt 沒對齊，而不是本專案 services/tts_service.py
包裝層（PCM 轉換、WebSocket 串流、asyncio.Queue 橋接）的問題。

這支腳本刻意完全照抄 CosyVoice 官方倉庫自帶的 CosyVoice/example.py 呼叫方式
（AutoModel → inference_zero_shot → torchaudio.save 直接存 wav），
不經過本專案任何一行自訂程式碼（除了必要的 load_wav monkeypatch，因為
torchaudio 新版預設會走 torchcodec 路徑，見 services/tts_service.py 的
_patch_cosyvoice_load_wav 說明），也不透過 WebSocket 或 PCM 轉換。

用法（在裝好 CosyVoice 2 依賴的 RTX 5090 環境跑）：
    cd voice_clone_backend
    python -m scripts.diagnose_cosyvoice_official

會在目前目錄輸出：
    diag_official_zero_shot_0.wav   官方預設參考音色（asset/zero_shot_prompt.wav）
    diag_official_zero_shot_1.wav   （若 inference_zero_shot 因串流分段回傳多個 chunk）
    diag_official_custom_profile_0.wav  若有指定 --profile-id，用該 voice profile 的
                                         參考音訊/逐字稿做同樣測試

判讀方式：
    - 如果連這支「完全照抄官方範例、零自訂程式碼」的腳本，合成出來的官方
      預設音色（asset/zero_shot_prompt.wav + 官方逐字稿）都會重複亂念，
      代表問題出在環境本身（套件版本、CUDA/cuDNN、GPU 驅動、模型權重檔案
      本身損毀等），而不是本專案的包裝程式碼——因為這裡的呼叫路徑跟
      CosyVoice 官方自己的 example.py 一字不差。
    - 如果官方預設音色合成正常、只有 --profile-id 指定的使用者自訂聲音
      合成出來會重複，代表問題出在該 voice profile 的參考音訊/逐字稿本身
      （品質、長度、跟逐字稿是否精準對應等），而不是環境或本專案程式碼。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_COSYVOICE_REPO_DIR = _BACKEND_DIR / "CosyVoice"
_MATCHA_TTS_DIR = _COSYVOICE_REPO_DIR / "third_party" / "Matcha-TTS"


def _print_env_versions() -> None:
    """列出關鍵套件實際安裝版本，方便跟官方 CosyVoice/requirements.txt 比對。"""
    import importlib.metadata as importlib_metadata

    print("=" * 70)
    print("目前安裝的關鍵套件版本（跟 CosyVoice/requirements.txt 官方版本比對）：")
    print("官方版本： torch==2.3.1 torchaudio==2.3.1 onnxruntime-gpu==1.18.0")
    print("          numpy==1.26.4 transformers==4.51.3 hyperpyyaml==1.2.3")
    print("-" * 70)
    for pkg_name in ("torch", "torchaudio", "onnxruntime", "onnxruntime-gpu", "numpy", "transformers", "hyperpyyaml"):
        try:
            version = importlib_metadata.version(pkg_name)
            print(f"  {pkg_name:20s} {version}")
        except importlib_metadata.PackageNotFoundError:
            pass
    try:
        import torch

        print(f"  torch.cuda.is_available()  {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            print(f"  torch.cuda.get_device_name(0)  {torch.cuda.get_device_name(0)}")
            print(f"  torch.version.cuda  {torch.version.cuda}")
    except Exception as exc:  # noqa: BLE001
        print(f"  （讀取 torch/CUDA 資訊失敗：{exc}）")
    print("=" * 70)


def _ensure_importable() -> None:
    for path in (_COSYVOICE_REPO_DIR, _MATCHA_TTS_DIR):
        path_str = str(path)
        if path.exists() and path_str not in sys.path:
            sys.path.insert(0, path_str)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--engine",
        choices=["cosyvoice2", "cosyvoice3"],
        default="cosyvoice2",
        help="用 CosyVoice2 還是 CosyVoice3（官方 README 建議用 Fun-CosyVoice3-0.5B 效果更好，"
        "架構/權重跟 CosyVoice2 不同，用來排查是不是 CosyVoice2-0.5B 這顆權重／架構本身的問題）",
    )
    parser.add_argument(
        "--model-dir",
        default="",
        help="權重路徑，留空則依 --engine 自動帶入預設路徑"
        "（cosyvoice2 → pretrained_models/CosyVoice2-0.5B，"
        "cosyvoice3 → pretrained_models/Fun-CosyVoice3-0.5B，需自行下載）",
    )
    parser.add_argument(
        "--text",
        default="面對失敗，重點只有兩個字：止損。",
        help="要合成的目標文字（預設用使用者實測回報時的那句話，方便重現）",
    )
    parser.add_argument("--profile-audio", default="", help="（可選）指定使用者自訂 voice profile 的參考音訊路徑")
    parser.add_argument("--profile-text", default="", help="（可選）該參考音訊的逐字稿，須跟 --profile-audio 搭配使用")
    parser.add_argument(
        "--stream",
        action="store_true",
        help="用 stream=True（正式服務 services/tts_service.py 實際使用的模式）而不是預設的 stream=False，"
        "方便比對「非串流」跟「串流分 chunk」兩種官方都支援的生成模式，結果是否一致",
    )
    parser.add_argument(
        "--fp16",
        action="store_true",
        help="用 fp16=True（正式服務在 cuda + 非 float32 profile 下實際使用的設定），"
        "預設 fp16=False 方便先排除半精度數值誤差這個變因",
    )
    parser.add_argument(
        "--allow-tf32",
        action="store_true",
        help="不要停用 TF32（預設會停用）。PyTorch 在 Ampere 以後的 GPU（含 Blackwell）"
        "預設會讓 fp32 矩陣乘法偷偷用精度較低的 TF32 加速，這個開關獨立於 --fp16"
        "（--fp16 只控制 autocast，不影響 TF32），是還沒測試過的變因；LLM 逐 token"
        "自迴歸生成有將近 200 步，累積的精度誤差可能比單一次 flow/hift 前向計算"
        "（VC 自我重建測試沒用到 LLM，測不到這個變因）大很多。",
    )
    args = parser.parse_args()

    _print_env_versions()
    _ensure_importable()

    import torch as _torch

    if not args.allow_tf32:
        _torch.backends.cuda.matmul.allow_tf32 = False
        _torch.backends.cudnn.allow_tf32 = False
        print(
            "已停用 TF32（torch.backends.cuda.matmul.allow_tf32 = False，"
            "torch.backends.cudnn.allow_tf32 = False）——這是還沒測過的變因，"
            "跟 --fp16 是兩回事：--fp16 只控制 autocast 範圍，TF32 預設在 Ampere"
            "以上的 GPU 對所有 fp32 矩陣乘法都會生效，除非明確關掉。"
            "若要保留 TF32（預設官方行為）用 --allow-tf32。"
        )
    else:
        print("保留 TF32 預設行為（--allow-tf32）。")

    # 套用跟正式服務完全相同的 monkeypatch：
    #   - _patch_cosyvoice_load_wav：torchcodec 依賴的相容性 workaround，
    #     已用合成 webm/opus 測試檔驗證解碼結果跟 ffmpeg 逐 sample一致，
    #     不是本次要排查的對象。
    #   - _patch_cosyvoice_attn_implementation：真正在追查的重複音節問題，
    #     見該函式 docstring。必須在 CosyVoice2(...) 建構「之前」呼叫，
    #     因為 Qwen2Encoder 是 hyperpyyaml 載入 cosyvoice2.yaml 當下就
    #     直接 instantiate 完成的。
    from services.tts_service import (
        _patch_cosyvoice_attn_implementation,
        _patch_cosyvoice_forward_one_step_position_ids,
        _patch_cosyvoice_load_wav,
    )

    if args.engine == "cosyvoice3":
        from cosyvoice.cli.cosyvoice import CosyVoice3 as _CosyVoiceCls

        default_model_dir = str(_BACKEND_DIR / "pretrained_models" / "Fun-CosyVoice3-0.5B")
        # CosyVoice3 的 prompt_text 規定要帶 <|endofprompt|> 標記（見官方
        # CosyVoice/example.py 的 cosyvoice3_example()），Qwen2LM 的子類
        # CosyVoice3LM.inference() 內部會 assert 151646（<|endofprompt|>
        # 的 token id）一定要出現在 text 或 prompt_text 裡，沒有會直接炸掉。
        official_prompt_text = "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。"
    else:
        from cosyvoice.cli.cosyvoice import CosyVoice2 as _CosyVoiceCls

        default_model_dir = str(_BACKEND_DIR / "pretrained_models" / "CosyVoice2-0.5B")
        official_prompt_text = "希望你以后能够做的比我还好呦。"

    model_dir = args.model_dir or default_model_dir

    _patch_cosyvoice_attn_implementation()
    _patch_cosyvoice_forward_one_step_position_ids()

    # ── 額外診斷：把 LLM 逐 token 自迴歸生成出來的「語音 token 序列」記錄
    # 下來（不是最終音訊，是 CosyVoice2 LLM 那一階段吐出來、後續才會交給
    # flow+hift 轉成波形的中間產物）。
    #
    # 為什麼要加這段：eager attention 那個修法套用後使用者實測回報還是
    # 重複亂念，代表問題不只是（或根本不是）sliding window attention 遮罩
    # 這一個成因。與其繼續憑經驗猜下一個修法，不如直接觀察生成出來的語音
    # token 序列本身：
    #   - 如果 token 序列本身就重複度極高（例如整段幾乎都是同一個 token
    #     或在少數幾個 token 間循環），代表退化發生在 LLM 自迴歸生成這一步
    #     （sampling / KV cache / attention 這一整條路徑都算），問題出在
    #     token 還沒送進 flow/hift 之前。
    #   - 如果 token 序列看起來正常（種類夠多、沒有異常重複），但最後的
    #     音訊還是重複亂念，代表問題其實出在 flow（CausalMaskedDiffWithXvec）
    #     或 hift（vocoder）這一段「token 轉波形」的計算，是完全不同的
    #     排查方向，目前都還沒檢查過。
    import cosyvoice.llm.llm as _cv_llm

    _generated_tokens: list[int] = []
    _original_sampling_ids = _cv_llm.TransformerLM.sampling_ids

    def _debug_sampling_ids(self, weighted_scores, decoded_tokens, sampling, ignore_eos=True):
        top_ids = _original_sampling_ids(self, weighted_scores, decoded_tokens, sampling, ignore_eos)
        _generated_tokens.append(top_ids)
        return top_ids

    _cv_llm.TransformerLM.sampling_ids = _debug_sampling_ids

    def _print_token_stats(label: str) -> None:
        from collections import Counter

        if not _generated_tokens:
            print(f"  [{label}] 沒有記錄到任何 token（可能是 bistream 或其他路徑，未攔截到）")
            return
        counts = Counter(_generated_tokens)
        total = len(_generated_tokens)
        unique = len(counts)
        top5 = counts.most_common(5)
        print(f"  [{label}] LLM 共生成 {total} 個語音 token，其中 {unique} 種不同 token")
        print(f"  [{label}] 出現次數最多的 5 個 token：{top5}")
        most_common_ratio = top5[0][1] / total if top5 else 0
        if most_common_ratio > 0.3:
            print(
                f"  [{label}] ⚠ 單一 token 佔比 {most_common_ratio:.1%}，"
                "疑似 LLM 自迴歸生成階段就已經退化重複（問題在 token 生成，不是 flow/vocoder）"
            )
        else:
            print(f"  [{label}] token 分布看起來正常，沒有單一 token 過度重複")
        _generated_tokens.clear()

    def _save_wav(path: str, tts_speech, sample_rate: int) -> None:
        """
        用 soundfile 存 wav，不用 torchaudio.save()。

        修過的真實問題：這台機器裝的 torchaudio（2.11.0+cu128）新到 save()
        預設也會走 torchcodec 路徑（跟先前 load_wav 遇到的 torchcodec 依賴
        是同一個成因，只是這次換成寫檔方向），沒裝 torchcodec 就直接
        ModuleNotFoundError，害這支診斷腳本在算完音訊、正要存檔驗聽前一步
        就当掉。用 soundfile 直接寫 wav 完全不需要 torchcodec，也是正式
        服務 _tts_speech_to_pcm16_bytes() 本來就採用的同一套「不依賴
        torchcodec」策略（該函式輸出 PCM bytes 而不是寫檔，這裡只是額外
        包一層存成 wav 方便直接播放驗聽）。
        """
        import numpy as np
        import soundfile as sf

        audio_np = tts_speech.detach().to("cpu").float().numpy().reshape(-1)
        audio_np = np.clip(audio_np, -1.0, 1.0)
        sf.write(path, audio_np, sample_rate, subtype="PCM_16")

    print(f"載入 {args.engine} 權重：{model_dir} …（stream={args.stream}, fp16={args.fp16}）")
    if args.engine == "cosyvoice3":
        # CosyVoice3.__init__ 沒有 load_jit 這個參數（跟 CosyVoice2 建構子簽名不同）。
        cosyvoice = _CosyVoiceCls(model_dir, load_trt=False, fp16=args.fp16)
    else:
        cosyvoice = _CosyVoiceCls(model_dir, load_jit=False, load_trt=False, fp16=args.fp16)
    _patch_cosyvoice_load_wav()
    print(f"載入完成，sample_rate={cosyvoice.sample_rate}")

    # ── 測試 0：純數據檢查，不跑生成 ──
    #
    # 為什麼要加這個：eager attention 跟 position_ids 兩個修法都沒解決
    # 問題，VC 自我重建測試已經證明 flow/hift/特徵抽取全部正常，範圍已經
    # 鎖定在「LLM 根據文字生成語音 token」這一段。與其繼續猜 forward_one_step
    # 內部細節，先做兩個便宜、決定性的檢查：
    #   (a) tokenizer 的詞彙表大小，是否跟模型 embedding table 的實際列數
    #       對得上。CosyVoice2Tokenizer 在 __init__ 裡會呼叫
    #       `self.tokenizer.add_special_tokens(...)` 額外塞進一批特殊
    #       token（<|im_start|>、[breath] 等），如果這批新 token 分配到的
    #       id 超出模型 embedding table 原本的大小，文字 token 一旦落在這個
    #       範圍，模型從 embedding table 查到的向量就會是「隨機初始化、
    #       完全沒訓練過」的內容或甚至索引越界——這種輸入條件錯誤，會讓
    #       LLM 生成出「有效但答非所問」的 token，跟目前症狀完全吻合。
    #   (b) tokenizer 對目標文字 encode 再 decode 一次，看還原出來的文字
    #       是否跟原本一致，確認中文文字進到 tokenizer 這一步本身沒有
    #       被錯誤切分或亂碼化。
    print("\n[測試 0] tokenizer / embedding 詞彙表大小檢查")
    try:
        frontend = cosyvoice.frontend
        tokenizer = frontend.tokenizer
        qwen_lm = cosyvoice.model.llm  # Qwen2LM
        text_embed_matrix = qwen_lm.llm.model.get_input_embeddings().weight
        speech_embed_matrix = qwen_lm.speech_embedding.weight
        decoder_out_features = qwen_lm.llm_decoder.out_features
        tokenizer_vocab_size = len(tokenizer.tokenizer)

        print(f"  tokenizer 詞彙表大小（含 add_special_tokens 後）：{tokenizer_vocab_size}")
        print(f"  LLM 文字 embedding table 列數：{text_embed_matrix.shape[0]}")
        print(f"  speech_embedding table 列數：{speech_embed_matrix.shape[0]}")
        print(f"  llm_decoder 輸出維度（可預測的語音 token 數）：{decoder_out_features}")
        if tokenizer_vocab_size > text_embed_matrix.shape[0]:
            print(
                f"  ⚠⚠⚠ tokenizer 詞彙表（{tokenizer_vocab_size}）比模型文字 embedding "
                f"table（{text_embed_matrix.shape[0]}）還大！只要文字 token 的 id 落在"
                "這個差距範圍內，模型查到的就是沒訓練過/越界的向量——非常可能就是問題根源。"
            )
        else:
            print("  tokenizer 詞彙表大小沒有超過 embedding table，這項檢查沒發現異常。")

        encoded = tokenizer.encode(args.text)
        decoded = tokenizer.decode(encoded)
        print(f"  目標文字：{args.text!r}")
        print(f"  encode 後 token id（前 30 個）：{encoded[:30]}")
        print(f"  decode 還原結果：{decoded!r}")
        if decoded.strip() != args.text.strip():
            print("  ⚠ decode 還原結果跟原始文字不一致，tokenizer 這一步本身可能有問題。")
        else:
            print("  encode→decode 還原一致，tokenizer 這一步本身看起來沒問題。")
    except Exception as exc:  # noqa: BLE001
        print(f"  （測試 0 檢查失敗，略過：{exc!r}）")

    # ── 測試 1：官方預設參考音色（跟 CosyVoice/example.py 完全一樣的呼叫方式）──
    # official_prompt_text 已依 --engine 在前面決定好（CosyVoice3 需要
    # <|endofprompt|> 標記，CosyVoice2 不用）。
    official_prompt_wav = str(_COSYVOICE_REPO_DIR / "asset" / "zero_shot_prompt.wav")
    print("\n[測試 1] 官方預設參考音色 + 官方範例逐字稿（跟 CosyVoice 自己的 example.py 一致）")
    for i, j in enumerate(
        cosyvoice.inference_zero_shot(args.text, official_prompt_text, official_prompt_wav, stream=args.stream)
    ):
        out_path = f"diag_official_zero_shot_{i}.wav"
        _save_wav(out_path, j["tts_speech"], cosyvoice.sample_rate)
        print(f"  已輸出：{out_path}")
    _print_token_stats("測試1")

    # ── 測試 2：使用者自訂 voice profile（若有提供）──
    if args.profile_audio and args.profile_text:
        print("\n[測試 2] 使用者自訂 voice profile 參考音訊")
        for i, j in enumerate(
            cosyvoice.inference_zero_shot(args.text, args.profile_text, args.profile_audio, stream=args.stream)
        ):
            out_path = f"diag_official_custom_profile_{i}.wav"
            _save_wav(out_path, j["tts_speech"], cosyvoice.sample_rate)
            print(f"  已輸出：{out_path}")
        _print_token_stats("測試2")
    else:
        print(
            "\n[測試 2] 略過（未提供 --profile-audio / --profile-text）。"
            "\n  若要測試自己上傳的克隆聲音，加上："
            "\n  python -m scripts.diagnose_cosyvoice_official "
            '--profile-audio "voice_profiles/tmp_xxxx.webm" --profile-text "逐字稿內容"'
        )

    # ── 測試 3：Voice Conversion 自我重建（完全跳過 LLM）──
    #
    # 為什麼要加這個測試：測試 1 印出的 token 統計顯示 LLM 生成的 190 個
    # 語音 token 裡有 139 種不同 token、沒有單一 token 過度重複，代表 LLM
    # 自迴歸生成「沒有」退化成最嚴重的那種重複 loop。但這只能排除「完全
    # 卡死重複」，排除不了「token 種類看起來正常、但內容其實不對」這種
    # 更細微的錯誤，也排除不了「token 本身沒問題、但後面 flow/hift 把
    # token 轉成波形這一步算錯」。
    #
    # inference_vc()（voice conversion）是官方本來就有的 API：給定
    # source_wav + prompt_wav，直接用 source_wav「真人語音」實際抽出來的
    # speech token（不是 LLM 生成的、是完全確定性的抽取結果）走
    # token2wav（flow+hift），完全繞過 LLM。這裡刻意讓 source_wav 跟
    # prompt_wav 用同一個檔案，等於是「用真人語音的真實 token，測 token
    # 轉波形這條路徑本身準不準」：
    #   - 如果這個自我重建測試出來的語音清楚、聽得出是在念
    #     「希望你以后能够做的比我还好呦」（asset/zero_shot_prompt.wav
    #     本來的內容），代表 flow/hift/speech token 抽取都沒問題，問題
    #     百分之百在 LLM 生成的 token 內容本身不對（即使沒有嚴重到卡死
    #     重複的程度）。
    #   - 如果這個測試出來的語音也是亂的，代表問題根本不在 LLM，是
    #     token→波形這段（flow 的 CausalMaskedDiffWithXvec 或 hift 的
    #     vocoder）或參考音訊特徵抽取（_extract_speech_feat / campplus
    #     speaker embedding）本身就有問題，需要往那個方向查。
    print(
        "\n[測試 3] Voice Conversion 自我重建（完全跳過 LLM，用真人語音的真實"
        "\nspeech token 直接走 flow+hift，驗證「token 轉波形」這段路徑本身"
        "\n準不準。應該要聽到清楚的「希望你以后能够做的比我还好呦」）"
    )
    for i, j in enumerate(cosyvoice.inference_vc(official_prompt_wav, official_prompt_wav, stream=args.stream)):
        out_path = f"diag_official_vc_selftest_{i}.wav"
        _save_wav(out_path, j["tts_speech"], cosyvoice.sample_rate)
        print(f"  已輸出：{out_path}")

    print(
        "\n完成。請直接播放上面輸出的 wav 檔：\n"
        "  - 如果連測試 1（官方預設音色、零自訂程式碼路徑）都重複亂念，\n"
        "    代表問題在環境本身（套件版本/CUDA/GPU 驅動/權重檔案），\n"
        "    不是本專案 services/tts_service.py 的包裝程式碼。\n"
        "  - 如果測試 1 正常、只有測試 2（你的克隆聲音）不正常，\n"
        "    代表問題在該 voice profile 的參考音訊/逐字稿本身。\n"
        "  - 測試 3（diag_official_vc_selftest_*.wav）最關鍵：\n"
        "    聽得清楚 → flow/hift/特徵抽取都沒問題，問題在 LLM 生成的\n"
        "    token 內容本身；聽不清楚/也是亂的 → 問題根本不在 LLM，在\n"
        "    token→波形這段或參考音訊特徵抽取。"
    )


if __name__ == "__main__":
    main()
