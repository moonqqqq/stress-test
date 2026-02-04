/**
 * SSE Channel Subscription Stress Test Client
 *
 * 사용법:
 *   node stress-test-client.js [channelId] [connections] [readDelay]
 *
 * 예시:
 *   node stress-test-client.js channel1 10 500   # channel1에 10개 연결, 500ms 딜레이
 *   node stress-test-client.js myChannel 5 1000  # myChannel에 5개 연결, 1초 딜레이
 */

const http = require('http');

const CHANNEL_ID = process.argv[2] || 'default';
const NUM_CONNECTIONS = parseInt(process.argv[3]) || 10;
const READ_DELAY_MS = parseInt(process.argv[4]) || 500;

console.log(`========================================`);
console.log(`SSE Channel Subscription Stress Test`);
console.log(`========================================`);
console.log(`Channel: ${CHANNEL_ID}`);
console.log(`Connections: ${NUM_CONNECTIONS}`);
console.log(`Read Delay: ${READ_DELAY_MS}ms (느릴수록 서버 버퍼 증가)`);
console.log(`========================================\n`);

let connectedCount = 0;
let totalBytesReceived = 0;

function createSlowConnection(id) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: `/sse/subscribe/${CHANNEL_ID}?bufferSize=1024&interval=10`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        connectedCount++;
        console.log(`[Client ${id}] Connected to channel: ${CHANNEL_ID} (${connectedCount}/${NUM_CONNECTIONS})`);

        let bytesReceived = 0;
        let isPaused = false;

        res.on('data', (chunk) => {
          bytesReceived += chunk.length;
          totalBytesReceived += chunk.length;

          // 스트림 일시 정지 (서버는 계속 보내지만 우리는 안 읽음)
          if (!isPaused) {
            isPaused = true;
            res.pause();

            // READ_DELAY_MS 후에 다시 읽기 시작
            setTimeout(() => {
              isPaused = false;
              res.resume();
            }, READ_DELAY_MS);
          }
        });

        res.on('end', () => {
          console.log(`[Client ${id}] Ended - Received: ${Math.round(bytesReceived / 1024 / 1024)}MB`);
          connectedCount--;
        });

        res.on('error', (err) => {
          console.error(`[Client ${id}] Error: ${err.message}`);
          connectedCount--;
        });

        resolve({ id, req, res });
      },
    );

    req.on('error', (err) => {
      console.error(`[Client ${id}] Connection failed: ${err.message}`);
      resolve(null);
    });

    req.end();
  });
}

// 연결만 하고 아예 안 읽는 좀비 클라이언트
function createZombieConnection(id) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: `/sse/subscribe/${CHANNEL_ID}?bufferSize=1024&interval=10`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        connectedCount++;
        console.log(`[Zombie ${id}] Connected - NOT READING DATA`);

        // 데이터를 전혀 읽지 않음 - 서버 버퍼가 계속 쌓임
        res.pause();

        res.on('close', () => {
          connectedCount--;
        });

        resolve({ id, req, res });
      },
    );

    req.on('error', (err) => {
      console.error(`[Zombie ${id}] Failed: ${err.message}`);
      resolve(null);
    });

    req.end();
  });
}

async function runStressTest() {
  const mode = process.argv[5] || 'slow';
  console.log(`Mode: ${mode === 'zombie' ? 'ZOMBIE (no read)' : 'SLOW (delayed read)'}\n`);
  console.log(`Starting ${NUM_CONNECTIONS} connections to channel: ${CHANNEL_ID}...\n`);

  const connections = [];

  for (let i = 1; i <= NUM_CONNECTIONS; i++) {
    let conn;
    if (mode === 'zombie') {
      conn = await createZombieConnection(i);
    } else {
      conn = await createSlowConnection(i);
    }

    if (conn) connections.push(conn);

    if (i % 5 === 0) {
      console.log(`--- ${i}/${NUM_CONNECTIONS} connections established ---`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log(`\n========================================`);
  console.log(`All ${connectedCount} connections active on channel: ${CHANNEL_ID}`);
  console.log(`Press Ctrl+C to stop.`);
  console.log(`========================================\n`);

  // 상태 모니터링
  setInterval(() => {
    console.log(
      `[Monitor] Channel: ${CHANNEL_ID} | Active: ${connectedCount} | Total received: ${Math.round(totalBytesReceived / 1024 / 1024)}MB`,
    );
  }, 2000);
}

process.on('SIGINT', () => {
  console.log(`\nTotal bytes received: ${Math.round(totalBytesReceived / 1024 / 1024)}MB`);
  process.exit(0);
});

runStressTest().catch(console.error);
