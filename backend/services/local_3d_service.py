"""
local_3d_service.py - 本地 3D 生成服務（TripoSR 版）

主要流程：
  1. 接收圖像 bytes
  2. 用 rembg 移除背景
  3. 送入 TripoSR 推論，輸出 trimesh 網格
  4. 以 GLB 格式回傳

Fallback：若 TripoSR 不可用（套件未安裝、記憶體不足等），
          自動退回舊版純 Python 浮雕演算法。

模型來源：stabilityai/TripoSR（HuggingFace Hub，首次使用時自動下載 ~1GB）
          或手動下載放在 services/TripoSR/pretrained/ 資料夾。
"""

import io
import json
import logging
import os
import struct
import sys
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# ── TripoSR 路徑設定 ───────────────────────────────────────────────────────────
# 此檔案在 backend/services/，TripoSR 在 backend/services/TripoSR/
_TRIPOSR_DIR = Path(__file__).parent / "TripoSR"
_TRIPOSR_PRETRAINED = _TRIPOSR_DIR / "pretrained"   # 可選的本地模型路徑

# 把 TripoSR 目錄加入 Python 路徑（讓 `from tsr.xxx import ...` 可用）
if str(_TRIPOSR_DIR) not in sys.path:
    sys.path.insert(0, str(_TRIPOSR_DIR))

# ── 嘗試匯入 TripoSR 依賴 ─────────────────────────────────────────────────────
_TRIPOSR_AVAILABLE = False
_TSR_MODEL = None           # 全域單例，避免重複載入
_REMBG_SESSION = None       # rembg session 單例

try:
    import torch
    import trimesh
    import rembg
    from tsr.system import TSR
    from tsr.utils import remove_background, resize_foreground
    _TRIPOSR_AVAILABLE = True
    logger.info("TripoSR 依賴載入成功，將使用 TripoSR 進行 3D 生成")
except ImportError as _e:
    logger.warning(
        "TripoSR 依賴未安裝（%s），退回舊版浮雕演算法。"
        "請執行 install_triposr_deps.vbs 安裝套件。",
        _e,
    )


# ── TripoSR 模型載入（懶加載，首次呼叫時執行）─────────────────────────────────

def _get_device() -> str:
    """自動選擇運行裝置。"""
    if _TRIPOSR_AVAILABLE and torch.cuda.is_available():
        return "cuda:0"
    return "cpu"


def _load_tsr_model() -> "TSR":
    """載入 TripoSR 模型（全域單例）。"""
    global _TSR_MODEL, _REMBG_SESSION

    if _TSR_MODEL is not None:
        return _TSR_MODEL

    # 優先使用本地預訓練模型，否則從 HuggingFace Hub 下載
    if _TRIPOSR_PRETRAINED.is_dir() and (_TRIPOSR_PRETRAINED / "config.yaml").exists():
        model_source = str(_TRIPOSR_PRETRAINED)
        logger.info("從本地路徑載入 TripoSR：%s", model_source)
    else:
        model_source = "stabilityai/TripoSR"
        logger.info("從 HuggingFace Hub 下載 TripoSR（首次約需 1GB，請稍候）")

    device = _get_device()
    logger.info("使用裝置：%s", device)

    model = TSR.from_pretrained(
        model_source,
        config_name="config.yaml",
        weight_name="model.ckpt",
    )
    model.renderer.set_chunk_size(8192)
    model.to(device)
    model.eval()

    _TSR_MODEL = model
    _REMBG_SESSION = rembg.new_session()
    logger.info("TripoSR 模型載入完成")
    return _TSR_MODEL


# ── TripoSR 推論 ──────────────────────────────────────────────────────────────

def _preprocess_image(pil_image: Image.Image) -> Image.Image:
    """
    前處理：移除背景 + 將前景縮放至 85% 畫面大小。
    輸入 RGBA 或 RGB 皆可，輸出 RGB（灰色背景）。
    """
    # 確保 RGBA
    if pil_image.mode != "RGBA":
        pil_image = pil_image.convert("RGBA")

    # 移除背景
    image = remove_background(pil_image, _REMBG_SESSION)
    # 縮放前景到 85%（TripoSR 預設值）
    image = resize_foreground(image, 0.85)

    # 轉為 RGB（灰色背景合成）
    img_arr = np.array(image).astype(np.float32) / 255.0
    rgb = img_arr[:, :, :3]
    alpha = img_arr[:, :, 3:4]
    composited = rgb * alpha + 0.5 * (1.0 - alpha)   # 0.5 = 灰色背景
    return Image.fromarray((composited * 255.0).astype(np.uint8))


def _generate_glb_triposr(image_bytes: bytes) -> bytes:
    """
    使用 TripoSR 從圖像生成 GLB 模型。

    Args:
        image_bytes: 圖像原始位元組（PNG/JPEG/WebP）。

    Returns:
        GLB 二進位資料（bytes）。
    """
    # 確保模型已載入
    model = _load_tsr_model()
    device = _get_device()

    # 解析圖像
    pil_image = Image.open(io.BytesIO(image_bytes))
    logger.info("輸入圖像尺寸：%s, 模式：%s", pil_image.size, pil_image.mode)

    # 前處理
    processed = _preprocess_image(pil_image)
    logger.info("前處理完成，尺寸：%s", processed.size)

    # TripoSR 推論
    logger.info("開始 TripoSR 推論...")
    with torch.no_grad():
        scene_codes = model([processed], device=device)
    logger.info("推論完成，開始提取網格...")

    # 提取網格（vertex colors，解析度 256）
    meshes = model.extract_mesh(
        scene_codes,
        has_vertex_color=True,
        resolution=256,
    )
    mesh = meshes[0]
    logger.info("網格頂點數：%d，面數：%d", len(mesh.vertices), len(mesh.faces))

    # 套用方向修正（讓模型正面朝向 Three.js 相機）
    import trimesh as _trimesh
    mesh.apply_transform(
        _trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])
    )
    mesh.apply_transform(
        _trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0])
    )

    # 匯出 GLB
    glb_buf = io.BytesIO()
    mesh.export(glb_buf, file_type="glb")
    glb_data = glb_buf.getvalue()
    logger.info("GLB 生成完成：%d bytes", len(glb_data))
    return glb_data


# ── 舊版 GLB 浮雕演算法（Fallback）──────────────────────────────────────────

# GLB 常數
_GLB_MAGIC = 0x46546C67
_GLB_VERSION = 2
_CHUNK_JSON = 0x4E4F534A
_CHUNK_BIN = 0x004E4942
_FLOAT = 5126
_UNSIGNED_SHORT = 5123
_UNSIGNED_INT = 5125
_ARRAY_BUFFER = 34962
_ELEMENT_ARRAY_BUFFER = 34963


def _pad4(data: bytes, pad_byte: bytes = b"\x00") -> bytes:
    remainder = len(data) % 4
    if remainder:
        data += pad_byte * (4 - remainder)
    return data


def _build_relief_mesh(
    image: Image.Image,
    grid_w: int = 96,
    grid_h: int = 96,
    relief_depth: float = 0.55,
):
    """舊版浮雕網格生成（不需 GPU）。"""
    from PIL import ImageFilter

    rgba = np.array(image)
    r, g, b = rgba[:, :, 0], rgba[:, :, 1], rgba[:, :, 2]
    gray = (0.299 * r + 0.587 * g + 0.114 * b).astype(np.float32) / 255.0
    THRESH = 0.18
    fg = (gray > THRESH).astype(np.float32)

    PROC = 256
    fg_pil = Image.fromarray((fg * 255).astype(np.uint8), mode="L").resize(
        (PROC, PROC), Image.BILINEAR
    )
    gray_pil = Image.fromarray((gray * 255).astype(np.uint8), mode="L").resize(
        (PROC, PROC), Image.BILINEAR
    )

    dome = fg_pil
    for size in (3, 5, 9, 15, 21):
        dome = dome.filter(ImageFilter.MaxFilter(size))
        dome = dome.filter(ImageFilter.GaussianBlur(radius=size * 0.35))

    dome_arr = np.array(dome, dtype=np.float32) / 255.0
    fg_arr = np.array(fg_pil, dtype=np.float32) / 255.0
    gray_arr = np.array(gray_pil, dtype=np.float32) / 255.0

    height_map = dome_arr * fg_arr
    height_map = height_map * (0.75 + 0.25 * gray_arr)
    h_max = height_map.max()
    if h_max > 0:
        height_map = height_map / h_max

    h_img = Image.fromarray((height_map * 255).astype(np.uint8), mode="L")
    height_small = (
        np.array(h_img.resize((grid_w, grid_h), Image.BILINEAR), dtype=np.float32)
        / 255.0
    )

    xs = np.linspace(-1.0, 1.0, grid_w, dtype=np.float32)
    ys = np.linspace(1.0, -1.0, grid_h, dtype=np.float32)
    xv, yv = np.meshgrid(xs, ys)
    zv = height_small * relief_depth
    positions = np.stack([xv.ravel(), yv.ravel(), zv.ravel()], axis=1).astype(np.float32)

    us = np.linspace(0.0, 1.0, grid_w, dtype=np.float32)
    vs = np.linspace(0.0, 1.0, grid_h, dtype=np.float32)
    uv, vv = np.meshgrid(us, vs)
    texcoords = np.stack([uv.ravel(), 1.0 - vv.ravel()], axis=1).astype(np.float32)

    dz_dx = np.gradient(zv, axis=1) * (grid_w / 2.0)
    dz_dy = -np.gradient(zv, axis=0) * (grid_h / 2.0)
    nx = -dz_dx.ravel()
    ny = -dz_dy.ravel()
    nz = np.ones(len(nx), dtype=np.float32)
    length = np.sqrt(nx**2 + ny**2 + nz**2)
    length = np.where(length == 0, 1.0, length)
    normals = np.stack([nx / length, ny / length, nz / length], axis=1).astype(np.float32)

    indices = []
    for row in range(grid_h - 1):
        for col in range(grid_w - 1):
            tl = row * grid_w + col
            tr = tl + 1
            bl = tl + grid_w
            br = bl + 1
            indices.extend([tl, bl, tr, tr, bl, br])

    n_verts = len(positions)
    indices_arr = np.array(
        indices, dtype=np.uint32 if n_verts > 65535 else np.uint16
    )
    return positions, texcoords, normals, indices_arr


def _generate_glb_relief(image_bytes: bytes) -> bytes:
    """舊版浮雕 GLB 生成（fallback）。"""
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    except Exception as exc:
        raise ValueError(f"無法解析圖像：{exc}") from exc

    img_texture = img.resize((512, 512), Image.LANCZOS)
    png_buf = io.BytesIO()
    img_texture.save(png_buf, format="PNG", optimize=True)
    png_data = png_buf.getvalue()

    positions, texcoords, normals, indices = _build_relief_mesh(img)

    pos_bytes = positions.tobytes()
    tc_bytes = texcoords.tobytes()
    norm_bytes = normals.tobytes()
    idx_bytes = indices.tobytes()

    pos_padded = _pad4(pos_bytes)
    tc_padded = _pad4(tc_bytes)
    norm_padded = _pad4(norm_bytes)
    idx_padded = _pad4(idx_bytes)
    png_padded = _pad4(png_data)

    pos_offset = 0
    tc_offset = pos_offset + len(pos_padded)
    norm_offset = tc_offset + len(tc_padded)
    idx_offset = norm_offset + len(norm_padded)
    img_offset = idx_offset + len(idx_padded)
    total_bin = img_offset + len(png_padded)

    idx_component_type = _UNSIGNED_INT if indices.dtype == np.uint32 else _UNSIGNED_SHORT
    pos_min = positions.min(axis=0).tolist()
    pos_max = positions.max(axis=0).tolist()

    gltf = {
        "asset": {"version": "2.0", "generator": "drawing-to-3d-relief-fallback"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "relief"}],
        "meshes": [{"name": "relief_mesh", "primitives": [{
            "attributes": {"POSITION": 0, "TEXCOORD_0": 1, "NORMAL": 2},
            "indices": 3, "material": 0, "mode": 4,
        }]}],
        "materials": [{"name": "relief_mat", "pbrMetallicRoughness": {
            "baseColorTexture": {"index": 0},
            "metallicFactor": 0.0, "roughnessFactor": 0.85,
        }, "doubleSided": True}],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "images": [{"bufferView": 4, "mimeType": "image/png", "name": "texture"}],
        "accessors": [
            {"bufferView": 0, "byteOffset": 0, "componentType": _FLOAT, "count": len(positions), "type": "VEC3", "min": pos_min, "max": pos_max},
            {"bufferView": 1, "byteOffset": 0, "componentType": _FLOAT, "count": len(texcoords), "type": "VEC2"},
            {"bufferView": 2, "byteOffset": 0, "componentType": _FLOAT, "count": len(normals), "type": "VEC3"},
            {"bufferView": 3, "byteOffset": 0, "componentType": idx_component_type, "count": len(indices), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": pos_offset,  "byteLength": len(pos_bytes),  "target": _ARRAY_BUFFER},
            {"buffer": 0, "byteOffset": tc_offset,   "byteLength": len(tc_bytes),   "target": _ARRAY_BUFFER},
            {"buffer": 0, "byteOffset": norm_offset, "byteLength": len(norm_bytes), "target": _ARRAY_BUFFER},
            {"buffer": 0, "byteOffset": idx_offset,  "byteLength": len(idx_bytes),  "target": _ELEMENT_ARRAY_BUFFER},
            {"buffer": 0, "byteOffset": img_offset,  "byteLength": len(png_data)},
        ],
        "buffers": [{"byteLength": total_bin}],
    }

    json_str = json.dumps(gltf, separators=(",", ":"))
    json_bytes = json_str.encode("utf-8")
    json_padded = json_bytes + b" " * ((4 - len(json_bytes) % 4) % 4)
    bin_chunk = pos_padded + tc_padded + norm_padded + idx_padded + png_padded

    json_chunk_len = len(json_padded)
    bin_chunk_len = len(bin_chunk)
    total_len = 12 + 8 + json_chunk_len + 8 + bin_chunk_len

    return (
        struct.pack("<III", _GLB_MAGIC, _GLB_VERSION, total_len)
        + struct.pack("<II", json_chunk_len, _CHUNK_JSON)
        + json_padded
        + struct.pack("<II", bin_chunk_len, _CHUNK_BIN)
        + bin_chunk
    )


# ── 統一生成入口 ──────────────────────────────────────────────────────────────

def generate_glb(image_bytes: bytes) -> bytes:
    """
    生成 GLB（優先 TripoSR，失敗時退回浮雕演算法）。

    Args:
        image_bytes: 圖像原始位元組。

    Returns:
        GLB 二進位資料。
    """
    if _TRIPOSR_AVAILABLE:
        try:
            return _generate_glb_triposr(image_bytes)
        except Exception as exc:
            logger.error("TripoSR 生成失敗，退回浮雕演算法：%s", exc, exc_info=True)

    logger.info("使用浮雕演算法（fallback）生成 GLB")
    return _generate_glb_relief(image_bytes)


# ── FastAPI 服務層 ─────────────────────────────────────────────────────────────

class LocalGLBService:
    """
    本地 GLB 生成服務。

    接受圖像 bytes，回傳 GLB 的靜態 URL。
    """

    def __init__(self, output_dir: str = "outputs"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    async def image_to_3d(
        self,
        image_bytes: bytes,
        content_type: str = "image/png",
    ) -> dict:
        """
        生成 3D 模型並儲存 GLB。

        Returns:
            dict with task_id, status, model_url, thumbnail_url, progress
        """
        task_id = str(uuid.uuid4())
        filename = f"{task_id}.glb"
        out_path = self.output_dir / filename

        mode = "TripoSR" if _TRIPOSR_AVAILABLE else "relief-fallback"
        logger.info("3D 生成開始（%s）：task_id=%s", mode, task_id)

        try:
            glb_data = generate_glb(image_bytes)
        except Exception as exc:
            logger.error("GLB 生成失敗：%s", exc)
            raise RuntimeError(f"3D 生成失敗：{exc}") from exc

        out_path.write_bytes(glb_data)
        logger.info("GLB 已儲存：%s（%d bytes）", out_path, len(glb_data))

        return {
            "task_id": task_id,
            "status": "succeeded",
            "model_url": f"/static/{filename}",
            "thumbnail_url": None,
            "progress": 100,
        }
