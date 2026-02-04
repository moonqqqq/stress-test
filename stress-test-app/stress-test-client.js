/**
 * SSE Backpressure Stress Test Client
 *
 * 핵심: 클라이언트가 데이터를 느리게 읽어서 서버의 write 버퍼가 쌓이게 함
 *
 * 사용법:
 *   node stress-test-client.js [connections] [readDelay]
 *
 * 예시:
 *   node stress-test-client.js 100 100    # 100 연결, 100ms마다 읽기
 *   node stress-test-client.js 50 500     # 50 연결, 500ms마다 읽기 (더 느림)
 */

const http = require('http');

const NUM_CONNECTIONS = parseInt(process.argv[2]) || 100;
const READ_DELAY_MS = parseInt(process.argv[3]) || 100; // 클라이언트가 데이터 읽는 딜레이

console.log(`========================================`);
console.log(`SSE Backpressure Stress Test`);
console.log(`========================================`);
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
        path: '/sse/stream?chunkSize=1024&interval=10', // 1MB, 10ms 간격
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        connectedCount++;
        console.log(`[Client ${id}] Connected (${connectedCount}/${NUM_CONNECTIONS})`);

        let bytesReceived = 0;
        let isPaused = false;

        // 핵심: 데이터가 오면 일시정지하고, 딜레이 후에 다시 읽기
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

// 더 극단적인 버전: 연결만 하고 아예 안 읽음
function createZombieConnection(id) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: '/sse/stream-aggressive',
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

        // 가끔씩만 상태 확인
        const checker = setInterval(() => {
          console.log(`[Zombie ${id}] Still connected, not reading...`);
        }, 5000);

        res.on('close', () => {
          clearInterval(checker);
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

// Redis Pub/Sub 시뮬레이션 테스트: @Sse + Subject 조합
function createRedisConnection(id) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: '/sse/stream-redis',
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        connectedCount++;
        console.log(`[Redis ${id}] Connected - SLOW READING (Push-based source)`);

        let bytesReceived = 0;
        let isPaused = false;

        res.on('data', (chunk) => {
          bytesReceived += chunk.length;
          totalBytesReceived += chunk.length;

          // 느리게 읽기
          if (!isPaused) {
            isPaused = true;
            res.pause();
            setTimeout(() => {
              isPaused = false;
              res.resume();
            }, READ_DELAY_MS);
          }
        });

        res.on('close', () => {
          console.log(`[Redis ${id}] Closed - Received: ${Math.round(bytesReceived / 1024 / 1024)}MB`);
          connectedCount--;
        });

        resolve({ id, req, res });
      },
    );

    req.on('error', (err) => {
      console.error(`[Redis ${id}] Failed: ${err.message}`);
      resolve(null);
    });

    req.end();
  });
}

async function runStressTest() {
  const mode = process.argv[4] || 'slow';

  const modeLabels = {
    slow: 'SLOW (delayed read)',
    zombie: 'ZOMBIE (no read)',
    redis: 'REDIS (push-based source + slow read)',
  };
  console.log(`Mode: ${modeLabels[mode] || mode}\n`);
  console.log(`Starting ${NUM_CONNECTIONS} connections...\n`);

  const connections = [];

  for (let i = 1; i <= NUM_CONNECTIONS; i++) {
    let conn;
    if (mode === 'zombie') {
      conn = await createZombieConnection(i);
    } else if (mode === 'redis') {
      conn = await createRedisConnection(i);
    } else {
      conn = await createSlowConnection(i);
    }

    if (conn) connections.push(conn);

    // 10개씩 그룹으로 연결
    if (i % 10 === 0) {
      console.log(`--- ${i}/${NUM_CONNECTIONS} connections established ---`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  console.log(`\n========================================`);
  console.log(`All ${connectedCount} connections active!`);
  console.log(`Press Ctrl+C to stop.`);
  console.log(`========================================\n`);

  // 상태 모니터링
  setInterval(() => {
    console.log(
      `[Monitor] Active: ${connectedCount} | Total received: ${Math.round(totalBytesReceived / 1024 / 1024)}MB`,
    );
  }, 2000);
}

process.on('SIGINT', () => {
  console.log(`\nTotal bytes received: ${Math.round(totalBytesReceived / 1024 / 1024)}MB`);
  process.exit(0);
});

runStressTest().catch(console.error);
