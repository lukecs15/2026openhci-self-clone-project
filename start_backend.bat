@echo off
title Drawing-to-3D Backend
:: 切換到 backend 目錄（使用 bat 檔所在位置的絕對路徑）
set ROOT=%~dp0
set BACKEND=%ROOT%backend
set VENV=%ROOT%venv

echo [Backend] 工作目錄: %BACKEND%
cd /d "%BACKEND%"
echo [Backend] 目前目錄: %CD%

call "%VENV%\Scripts\activate.bat"
echo [Backend] 啟動 uvicorn...
python -m uvicorn main:app --reload --reload-dir "%BACKEND%" --host 0.0.0.0 --port 8000
pause
