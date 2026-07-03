@echo off
title Drawing-to-3D Frontend
cd /d "%~dp0frontend"
echo [Frontend] 啟動 Vite 開發伺服器...
if not exist node_modules (
    echo [Frontend] 第一次執行，安裝 npm 套件中...
    npm install
)
npm run dev
pause
