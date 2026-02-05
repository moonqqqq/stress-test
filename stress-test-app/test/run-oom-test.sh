#!/bin/bash

# Docker 기반 OOM 테스트 실행 스크립트

set -e

echo "==================================="
echo "  SSE 서버 OOM 테스트 (Docker)"
echo "==================================="
echo ""

# 1. 기존 컨테이너 정리
echo "[1/5] 기존 컨테이너 정리..."
docker-compose down 2>/dev/null || true

# 2. 이미지 빌드
echo ""
echo "[2/5] Docker 이미지 빌드..."
docker-compose build

# 3. 서버 + Redis 시작
echo ""
echo "[3/5] 서버 시작 (메모리 제한: 256MB)..."
docker-compose up -d redis server

echo "서버 시작 대기 중..."
sleep 5

# 4. 테스트 클라이언트 시작
echo ""
echo "[4/5] 테스트 클라이언트 시작..."
echo "  - slow-client: SSE 연결 후 데이터 소비 안함"
echo "  - data-flood: 100KB x 100개/초 = ~10MB/sec 전송"
echo ""

docker-compose --profile test up -d slow-client
sleep 2
docker-compose --profile test up -d data-flood

# 5. 모니터링
echo ""
echo "[5/5] 서버 메모리 모니터링 시작..."
echo "====================================="
echo ""

# 서버 컨테이너 ID
SERVER_CONTAINER=$(docker-compose ps -q server)

echo "서버 컨테이너: $SERVER_CONTAINER"
echo "메모리 제한: 256MB"
echo ""
echo "Ctrl+C로 중단"
echo ""

# 메모리 사용량 실시간 모니터링
while true; do
  STATS=$(docker stats --no-stream --format "{{.MemUsage}} / {{.MemPerc}}" $SERVER_CONTAINER 2>/dev/null)
  if [ -z "$STATS" ]; then
    echo ""
    echo "====================================="
    echo "서버 컨테이너가 종료됨 (OOM 발생 가능)"
    echo "====================================="
    echo ""
    echo "컨테이너 로그 확인:"
    docker-compose logs --tail=50 server
    echo ""
    echo "컨테이너 종료 상태:"
    docker inspect $SERVER_CONTAINER --format='{{.State.OOMKilled}}' 2>/dev/null && echo "(OOMKilled: true = OOM으로 종료됨)"
    break
  fi
  echo "[$(date +%H:%M:%S)] 메모리: $STATS"
  sleep 1
done

echo ""
echo "테스트 종료. 정리하려면: docker-compose down"
