/**
 * 데이터 폭주 생성기
 * Redis를 통해 대량의 데이터를 빠르게 전송하여 서버 버퍼를 채움
 */
import Redis from 'ioredis';

const SESSION_ID = process.argv[2] || 'test-session';
const MESSAGE_SIZE_KB = parseInt(process.argv[3] || '100'); // 메시지당 크기 (KB)
const MESSAGES_PER_SECOND = parseInt(process.argv[4] || '100'); // 초당 메시지 수

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

const channel = `llm:response:${SESSION_ID}`;

// 큰 메시지 생성
function generateLargeMessage(sizeKB: number): string {
  const content = 'X'.repeat(sizeKB * 1024);
  return JSON.stringify({
    timestamp: Date.now(),
    content,
  });
}

let totalSent = 0;
let totalBytes = 0;

console.log(`[DataFlood] Starting flood to channel: ${channel}`);
console.log(`[DataFlood] Message size: ${MESSAGE_SIZE_KB}KB, Rate: ${MESSAGES_PER_SECOND}/sec`);
console.log(`[DataFlood] Data rate: ~${(MESSAGE_SIZE_KB * MESSAGES_PER_SECOND / 1024).toFixed(2)} MB/sec`);
console.log('');

const message = generateLargeMessage(MESSAGE_SIZE_KB);
const messageBytes = Buffer.byteLength(message);

const intervalMs = 1000 / MESSAGES_PER_SECOND;

const interval = setInterval(() => {
  redis.publish(channel, message);
  totalSent++;
  totalBytes += messageBytes;

  if (totalSent % 100 === 0) {
    console.log(
      `[DataFlood] Sent: ${totalSent} messages, ` +
        `Total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
    );
  }
}, intervalMs);

// 상태 출력
setInterval(() => {
  console.log(
    `[DataFlood] Status - Messages: ${totalSent}, ` +
      `Data sent: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
  );
}, 5000);

process.on('SIGINT', () => {
  console.log('\n[DataFlood] Stopping...');
  console.log(`[DataFlood] Final - Messages: ${totalSent}, Data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  clearInterval(interval);
  redis.disconnect();
  process.exit(0);
});
