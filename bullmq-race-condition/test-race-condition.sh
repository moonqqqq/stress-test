#!/bin/bash

echo "🧪 BullMQ Race Condition Test"
echo "=============================="
echo ""
echo "1. Starting research job..."
echo ""

# 작업 시작
RESPONSE=$(curl -s -X POST http://localhost:3000/research/start \
  -H "Content-Type: application/json" \
  -d '{"query": "What is artificial intelligence?"}')

echo "Response: $RESPONSE"
echo ""

JOB_ID=$(echo $RESPONSE | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

echo "Job ID: $JOB_ID"
echo ""
echo "2. Waiting 15 seconds for job processing..."
echo "   (Watch the server logs for duplicate worker messages)"
echo ""

sleep 15

echo ""
echo "3. Checking stream history for duplicates..."
echo ""

curl -s http://localhost:3000/research/history/$JOB_ID | python3 -m json.tool

echo ""
echo "=============================="
echo "🔍 Look for:"
echo "   - Multiple 'started' events with different workerIds"
echo "   - Same 'step' numbers from different workers"
echo "   - Multiple 'completed' events"
echo "=============================="
