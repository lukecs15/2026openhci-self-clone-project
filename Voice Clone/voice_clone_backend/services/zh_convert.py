"""
services/zh_convert.py — 繁體 → 簡體轉換（CosyVoice 合成前處理）

為什麼需要：CosyVoice 的訓練語料以簡體中文為主，餵繁體文字時大部分常用字
沒問題，但「特殊字／罕用繁體字」的字音對應（g2p）覆蓋率明顯較差，實測會
出現發音不標準的狀況。解法是在「送進模型合成之前」把文字轉成簡體——
發音是同一套普通話，模型在簡體上的覆蓋率好得多；而前端字幕顯示的文字
（agent_speaking_chunk 的 text 欄位）完全不經過這裡，維持繁體不受影響。

刻意用 OpenCC 的 t2s（純字元層級）而不是 tw2sp（台灣用語→大陸用語）：
tw2sp 會換掉整個詞（例如「影片」→「视频」），聽到的內容會跟字幕對不上；
t2s 只轉字形，逐字對應，唸出來跟字幕一字不差。

依賴：opencc（pip install opencc-python-reimplemented，純 Python 實作，
不需要編譯）。沒安裝時優雅降級為原文直出（只警告一次），不會讓 TTS 掛掉。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_converter = None
_warned_missing = False


def _get_converter():
    global _converter, _warned_missing
    if _converter is not None:
        return _converter
    try:
        from opencc import OpenCC

        _converter = OpenCC("t2s")
    except Exception as exc:  # noqa: BLE001 — 缺套件/初始化失敗都走降級
        if not _warned_missing:
            _warned_missing = True
            logger.warning(
                "OpenCC 不可用（%s），TTS 文字將以繁體原文送入 CosyVoice；"
                "特殊繁體字的發音可能不標準。安裝方式："
                "pip install opencc-python-reimplemented",
                exc,
            )
        _converter = False  # 標記為「試過且失敗」，之後不再重試
    return _converter


def to_simplified(text: str) -> str:
    """
    繁體 → 簡體（t2s 字元層級）。OpenCC 不可用時回傳原文。

    ASCII／標點／<|endofprompt|> 這類標記不受影響（OpenCC 只動漢字），
    但保險起見呼叫端仍應在「加上模型控制標記之前」做轉換。
    """
    if not text:
        return text
    converter = _get_converter()
    if not converter:
        return text
    try:
        return converter.convert(text)
    except Exception as exc:  # noqa: BLE001 — 轉換失敗不應讓合成整個失敗
        logger.warning("繁轉簡失敗（%s），改用原文送入 TTS", exc)
        return text
