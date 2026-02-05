/**
 * 느린 클라이언트 시뮬레이터
 * SSE에 연결하지만 데이터를 소비하지 않아 서버 버퍼가 쌓이게 함
 */
import * as http from 'http';

const SESSION_ID = process.argv[2] || 'test-session';
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '3000');

console.log(`[SlowClient] Connecting to SSE: ${SERVER_HOST}:${SERVER_PORT}/sse/chat/${SESSION_ID}`);

const req = http.request(
  {
    hostname: SERVER_HOST,
    port: SERVER_PORT,
    path: `/sse/chat/${SESSION_ID}`,
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  },
  (res) => {
    console.log(`[SlowClient] Connected! Status: ${res.statusCode}`);
    console.log('[SlowClient] Now intentionally NOT consuming data...');
    console.log('[SlowClient] Server buffer should grow over time.');

    // 데이터 이벤트를 등록하지 않거나, pause()를 호출하여 소비를 멈춤
    res.pause();

    // 연결 상태만 유지
    let elapsed = 0;
    setInterval(() => {
      elapsed += 5;
      console.log(`[SlowClient] Connection alive for ${elapsed}s (not consuming data)`);
    }, 5000);
  },
);

req.on('error', (err) => {
  console.error('[SlowClient] Error:', err.message);
});

req.end();

// 프로세스 종료 방지
process.on('SIGINT', () => {
  console.log('[SlowClient] Disconnecting...');
  req.destroy();
  process.exit(0);
});
