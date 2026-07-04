Set objShell = WScript.CreateObject("WScript.Shell")
objShell.Run "cmd.exe /k ""cd /d C:\Users\User\Desktop\drawing_to_3d && call venv\Scripts\activate.bat && python run_tests.py""", 1, False
