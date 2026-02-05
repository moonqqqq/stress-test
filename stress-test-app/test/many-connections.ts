/**
 * 다중 연결 테스트
 * 많은 수의 SSE 연결을 생성하여 연결당 메모리 누적으로 OOM 유발
 */
import * as http from 'http';

const NUM_CONNECTIONS = parseInt(process.argv[2] || '500');
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '3000');
const CONNECTIONS_PER_BATCH = 50; // 한 번에 생성할 연결 수
const BATCH_DELAY_MS = 500; // 배치 간 대기 시간

const connections: http.ClientRequest[] = [];
let connectedCount = 0;
let errorCount = 0;

function createConnection(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: `/sse/chat/${sessionId}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      },
      (res) => {
        connectedCount++;
        // 데이터를 소비하지 않음 (pause)
        res.pause();
        resolve();
      },
    );

    req.on('error', (err) => {
      errorCount++;
      console.error(`[Connection Error] ${sessionId}: ${err.message}`);
      resolve();
    });

    connections.push(req);
    req.end();
  });
}

async function createConnectionsBatch(startIndex: number, count: number): Promise<void> {
  const promises: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const sessionId = `stress-session-${startIndex + i}`;
    promises.push(createConnection(sessionId));
  }
  await Promise.all(promises);
}

async function main() {
  console.log(`[ManyConnections] Starting stress test`);
  console.log(`[ManyConnections] Target: ${NUM_CONNECTIONS} connections`);
  console.log(`[ManyConnections] Server: ${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`[ManyConnections] Batch size: ${CONNECTIONS_PER_BATCH}, Delay: ${BATCH_DELAY_MS}ms`);
  console.log('');

  const startTime = Date.now();

  for (let i = 0; i < NUM_CONNECTIONS; i += CONNECTIONS_PER_BATCH) {
    const batchSize = Math.min(CONNECTIONS_PER_BATCH, NUM_CONNECTIONS - i);
    await createConnectionsBatch(i, batchSize);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[ManyConnections] Progress: ${connectedCount}/${NUM_CONNECTIONS} connected, ` +
      `${errorCount} errors, ${elapsed}s elapsed`
    );

    if (i + CONNECTIONS_PER_BATCH < NUM_CONNECTIONS) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log('');
  console.log(`[ManyConnections] All connections established!`);
  console.log(`[ManyConnections] Connected: ${connectedCount}, Errors: ${errorCount}`);
  console.log(`[ManyConnections] Keeping connections alive...`);
  console.log(`[ManyConnections] Press Ctrl+C to disconnect all`);

  // 상태 출력
  setInterval(() => {
    console.log(
      `[ManyConnections] Status - Active: ${connectedCount}, Errors: ${errorCount}`
    );
  }, 10000);
}

process.on('SIGINT', () => {
  console.log('\n[ManyConnections] Disconnecting all...');
  connections.forEach((req) => req.destroy());
  console.log(`[ManyConnections] Disconnected ${connections.length} connections`);
  process.exit(0);
});

main().catch(console.error);
