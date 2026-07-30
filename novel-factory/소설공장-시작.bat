@echo off
chcp 65001 >nul
title 소설 공장
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요.
  pause
  exit /b 1
)
echo 소설 공장 대시보드를 시작합니다...
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:8765"
node src\web.js
pause
