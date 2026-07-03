"""
demo_runner.py - 自動 demo 截圖工具

執行流程：
1. 截圖目前畫面（服務確認）
2. 導航到首頁截圖
3. 導航到繪製頁面截圖
4. 導航到 3D 模型頁面截圖（前視 + 等一下旋轉）
5. 截圖人格問卷
6. 截圖對話頁面

需要先在瀏覽器完成：畫圖、生成 3D、填問卷、開始對話
此腳本只負責導航 + 截圖
"""

import os
import sys
import time
import subprocess
from pathlib import Path
from PIL import ImageGrab

OUT_DIR = Path(r"C:\Users\User\Desktop\demo_screenshots")
OUT_DIR.mkdir(parents=True, exist_ok=True)

BASE_URL = "http://localhost:5173"


def ss(name: str, delay: float = 1.5):
    """等待 delay 秒後截圖並儲存。"""
    time.sleep(delay)
    img = ImageGrab.grab()
    path = OUT_DIR / name
    img.save(str(path))
    print(f"✅ 截圖已儲存：{path}")
    return str(path)


def open_url(url: str):
    """用 Chrome 開啟 URL。"""
    subprocess.Popen([
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "--new-window" if "new-window" in url else url.replace("--new-window", "").strip()
    ] if False else [
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        url
    ])
    time.sleep(2.5)


def navigate(url: str):
    """導航 Chrome 到指定 URL（開新視窗）。"""
    subprocess.Popen([
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        url
    ])
    time.sleep(2.5)


results = {}

step = sys.argv[1] if len(sys.argv) > 1 else "all"

if step in ("1", "all"):
    print("\n▶ Step 1: 確認服務狀態")
    results["01_services"] = ss("01_services.png", delay=0.5)

if step in ("2", "all"):
    print("\n▶ Step 2: 首頁（繪製頁）")
    navigate(f"{BASE_URL}/")
    results["02_homepage"] = ss("02_homepage.png", delay=2.0)

if step in ("3", "all"):
    print("\n▶ Step 3: 繪圖功能（需要使用者已畫圖）")
    navigate(f"{BASE_URL}/")
    results["03_drawing"] = ss("03_drawing.png", delay=2.0)

if step in ("4", "all"):
    print("\n▶ Step 4: 3D 模型展示")
    navigate(f"{BASE_URL}/model")
    results["04_model_front"] = ss("04_model_front.png", delay=2.5)

if step in ("5", "all"):
    print("\n▶ Step 5: 人格問卷")
    navigate(f"{BASE_URL}/model")
    results["05_personality"] = ss("05_personality.png", delay=2.0)

if step in ("6", "all"):
    print("\n▶ Step 6: 對話頁面")
    navigate(f"{BASE_URL}/chat")
    results["06_chat"] = ss("06_chat.png", delay=2.5)

print("\n==============================")
print("📸 所有截圖路徑：")
for k, v in results.items():
    print(f"  {k}: {v}")
print("==============================")
