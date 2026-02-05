/**
 * 정상 클라이언트 시뮬레이터
 * SSE에 연결하고 데이터를 정상 속도로 소비
 */
import * as http from 'http';

const NUM_CLIENTS = parseInt(process.argv[2] || '100');
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '3000');
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 200;

interface ClientStats {
  sessionId: string;
  messagesReceived: number;
  bytesReceived: number;
  connected: boolean;
}

const clients: Map<string, ClientStats> = new Map();
let totalConnected = 0;
let totalMessages = 0;
let totalBytes = 0;
let totalErrors = 0;

function createClient(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const stats: ClientStats = {
      sessionId,
      messagesReceived: 0,
      bytesReceived: 0,
      connected: false,
    };
    clients.set(sessionId, stats);

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
        stats.connected = true;
        totalConnected++;

        // 데이터를 정상적으로 소비
        res.on('data', (chunk: Buffer) => {
          stats.messagesReceived++;
          stats.bytesReceived += chunk.length;
          totalMessages++;
          totalBytes += chunk.length;
        });

        res.on('end', () => {
          stats.connected = false;
          totalConnected--;
        });

        res.on('error', () => {
          stats.connected = false;
          totalConnected--;
          totalErrors++;
        });

        resolve();
      },
    );

    req.on('error', (err) => {
      totalErrors++;
      console.error(`[Client ${sessionId}] Error: ${err.message}`);
      resolve();
    });

    req.end();
  });
}

async function createClientsBatch(startIndex: number, count: number): Promise<void> {
  const promises: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const sessionId = `normal-session-${startIndex + i}`;
    promises.push(createClient(sessionId));
  }
  await Promise.all(promises);
}

async function main() {
  console.log(`[NormalClient] Starting ${NUM_CLIENTS} normal clients`);
  console.log(`[NormalClient] Server: ${SERVER_HOST}:${SERVER_PORT}`);
  console.log('');

  const startTime = Date.now();

  // 클라이언트 생성
  for (let i = 0; i < NUM_CLIENTS; i += BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE, NUM_CLIENTS - i);
    await createClientsBatch(i, batchSize);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[NormalClient] Connected: ${totalConnected}/${NUM_CLIENTS}, ` +
      `Errors: ${totalErrors}, ${elapsed}s elapsed`
    );

    if (i + BATCH_SIZE < NUM_CLIENTS) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log('');
  console.log(`[NormalClient] All clients connected!`);
  console.log(`[NormalClient] Active: ${totalConnected}, Errors: ${totalErrors}`);
  console.log('');

  // 상태 출력
  setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(
      `[NormalClient] [${elapsed}s] Active: ${totalConnected}, ` +
      `Messages: ${totalMessages}, ` +
      `Data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB, ` +
      `Errors: ${totalErrors}`
    );
  }, 5000);
}

process.on('SIGINT', () => {
  console.log('\n[NormalClient] Shutting down...');
  console.log(`[NormalClient] Final - Messages: ${totalMessages}, Data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  process.exit(0);
});

main().catch(console.error);
