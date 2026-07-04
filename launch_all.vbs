Set objShell = WScript.CreateObject("WScript.Shell")

' 啟動 Backend
objShell.Run "cmd.exe /k ""cd /d C:\Users\User\Desktop\drawing_to_3d\backend && call C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\activate.bat && python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000""", 1, False

WScript.Sleep 3000

' 啟動 Frontend
objShell.Run "cmd.exe /k ""cd /d C:\Users\User\Desktop\drawing_to_3d\frontend && npm run dev""", 1, False
