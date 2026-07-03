Set objShell = WScript.CreateObject("WScript.Shell")
Dim py, script
py = "C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\python.exe"
script = "C:\Users\User\Desktop\drawing_to_3d\test_import.py"
' 等待完成 (True)，靜默執行 (0)
objShell.Run chr(34) & py & chr(34) & " " & chr(34) & script & chr(34), 0, True
MsgBox "診斷完成！請查看 drawing_to_3d\test_output.txt", 64, "記憶之物"
