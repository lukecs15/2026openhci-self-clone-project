Set objShell = WScript.CreateObject("WScript.Shell")
py = "C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\python.exe"
script = "C:\Users\User\Desktop\drawing_to_3d\screenshot_util.py"
out = WScript.Arguments(0)
objShell.Run chr(34) & py & chr(34) & " " & chr(34) & script & chr(34) & " " & chr(34) & out & chr(34), 0, True
