"""
快速診斷腳本：確認 backend 能否正常 import
結果寫入 test_output.txt
"""
import sys
import os
import traceback

BACKEND = r'C:\Users\User\Desktop\drawing_to_3d\backend'
OUT = r'C:\Users\User\Desktop\drawing_to_3d\test_output.txt'

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

lines = [f"Python: {sys.version}", f"CWD: {os.getcwd()}", ""]

# 嘗試 import 各模組
for mod in ['config', 'models.schemas', 'services.rag_service',
            'services.gemini_service', 'services.local_3d_service',
            'services.meshy_service', 'routers.image_to_3d',
            'routers.chat', 'routers.personality', 'main']:
    try:
        __import__(mod)
        lines.append(f"OK  {mod}")
    except Exception as e:
        lines.append(f"ERR {mod}: {e}")
        lines.append(traceback.format_exc())

with open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print("Done! See test_output.txt")
