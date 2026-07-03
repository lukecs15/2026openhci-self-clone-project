Set objShell = WScript.CreateObject("WScript.Shell")
Dim cmd
' 用 cmd /k 讓視窗保持開啟，直接傳入指令序列
cmd = "cmd.exe /k ""cd /d C:\Users\User\Desktop\drawing_to_3d\backend && call C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\activate.bat && python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000"""
objShell.Run cmd, 1, False
