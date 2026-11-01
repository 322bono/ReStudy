@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12 이상을 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)
node scripts\launch-web.mjs
if errorlevel 1 pause
