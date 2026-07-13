"""
routers/qr.py — QR code 圖片產生端點

供 Unity（VR 主系統）在 Start scene／End scene 顯示 QR 用：
    - Start scene：傳票公文上的 QR，內容是手機連結頁網址（帶 session_id），
      使用者用手機掃碼填問卷+上傳聲音樣本。
    - End scene / 展示螢幕：領取判決書的 QR，內容是手機結果頁網址。

Unity 端用 UnityWebRequestTexture 直接抓 PNG 貼上材質即可，不需要在
Unity 內建 QR 編碼函式庫（見 openHCI_G2 的 OnboardingApiClient.cs）。

安全性備註：data 參數是任意字串（本服務只在展場區網使用），僅限制長度
避免濫用；不做網址白名單（QR 內容由呼叫端 Unity 自行組出）。
"""

import io
import logging

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import Response

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/qr", tags=["QR Code"])

_MAX_DATA_LENGTH = 1024


@router.get("", summary="產生 QR code PNG 圖片")
async def generate_qr(
    data: str = Query(..., description="QR 內容（通常是手機連結頁/結果頁網址）"),
    size: int = Query(512, ge=64, le=2048, description="輸出 PNG 邊長（像素，近似值）"),
):
    if not data.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="data 不可為空")
    if len(data) > _MAX_DATA_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"data 過長（上限 {_MAX_DATA_LENGTH} 字元）"
        )

    try:
        import qrcode
        from qrcode.image.pil import PilImage  # noqa: F401 — 確認 PIL 後端可用
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=f"伺服器未安裝 qrcode 套件（pip install 'qrcode[pil]'）：{exc}",
        )

    qr = qrcode.QRCode(border=2)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    # 依要求的 size 重新取樣（QR 模組數量決定原始尺寸，這裡放大成呼叫端
    # 要的解析度，NEAREST 保持方塊邊緣銳利、不會糊掉）。
    pil = img.get_image() if hasattr(img, "get_image") else img
    from PIL import Image

    pil = pil.resize((size, size), Image.NEAREST)

    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")
