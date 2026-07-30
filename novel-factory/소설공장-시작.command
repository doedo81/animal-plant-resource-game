#!/bin/bash
# 맥용 더블클릭 실행 파일 (최초 1회: 우클릭 → 열기)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요."
  read -r -p "엔터를 누르면 닫힙니다..."
  exit 1
fi
echo "소설 공장 대시보드를 시작합니다..."
( sleep 2; open "http://127.0.0.1:8765" ) &
node src/web.js
