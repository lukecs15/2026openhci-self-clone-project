Set objShell = WScript.CreateObject("WScript.Shell")
Dim cmd
cmd = "cmd.exe /k ""cd /d C:\Users\User\Desktop\drawing_to_3d\frontend && npm install && npm run dev"""
objShell.Run cmd, 1, False
