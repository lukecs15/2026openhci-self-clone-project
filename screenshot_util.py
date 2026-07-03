"""截圖工具：呼叫時傳入輸出路徑即可儲存全螢幕截圖"""
import sys
import os
from PIL import ImageGrab

if len(sys.argv) < 2:
    print("Usage: screenshot_util.py <output_path>")
    sys.exit(1)

out = sys.argv[1]
os.makedirs(os.path.dirname(out), exist_ok=True)
ImageGrab.grab().save(out)
print(f"Saved: {out}")
