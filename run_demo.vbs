Set objShell = WScript.CreateObject("WScript.Shell")

Dim py
py = "C:\Users\User\Desktop\drawing_to_3d\venv\Scripts\python.exe"

Dim ssUtil
ssUtil = "C:\Users\User\Desktop\drawing_to_3d\screenshot_util.py"

Dim outDir
outDir = "C:\Users\User\Desktop\demo_screenshots\"

Sub SaveSS(fname)
    Dim p
    p = outDir & fname
    objShell.Run Chr(34) & py & Chr(34) & " " & Chr(34) & ssUtil & Chr(34) & " " & Chr(34) & p & Chr(34), 0, True
End Sub

Sub GoChrome(url)
    objShell.Run "cmd /c start chrome " & url, 0, False
    WScript.Sleep 2500
End Sub

' Step 1: Current state (services running)
WScript.Sleep 500
SaveSS "01_services.png"

' Step 2: Homepage / Drawing page
GoChrome "http://localhost:5173/"
WScript.Sleep 1000
SaveSS "02_homepage.png"

' Step 3: Drawing canvas (same page, second shot)
WScript.Sleep 1500
SaveSS "03_drawing_canvas.png"

' Step 4: 3D Model page
GoChrome "http://localhost:5173/model"
WScript.Sleep 3000
SaveSS "04_model_3d.png"

' Step 5: Personality form (same page)
WScript.Sleep 1000
SaveSS "05_personality_form.png"

' Step 6: Chat page
GoChrome "http://localhost:5173/chat"
WScript.Sleep 2500
SaveSS "06_chat_page.png"

MsgBox "Demo done! Check: " & outDir, 64, "Done"
