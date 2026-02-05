/**
 * 다중 세션 데이터 폭주
 * 여러 세션에 동시에 데이터를 전송하여 연결당 버퍼 누적
 */
import Redis from 'ioredis';

const NUM_SESSIONS = parseInt(process.argv[2] || '500');
const MESSAGE_SIZE_KB = parseInt(process.argv[3] || '10');
const MESSAGES_PER_SECOND = parseInt(process.argv[4] || '10');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

function generateMessage(sizeKB: number): string {
  const content = 'X'.repeat(sizeKB * 1024);
  return JSON.stringify({
    timestamp: Date.now(),
    content,
  });
}

let totalSent = 0;
let totalBytes = 0;

console.log(`[MultiFlood] Starting multi-session flood`);
console.log(`[MultiFlood] Sessions: ${NUM_SESSIONS}`);
console.log(`[MultiFlood] Message size: ${MESSAGE_SIZE_KB}KB`);
console.log(`[MultiFlood] Rate: ${MESSAGES_PER_SECOND}/sec per session`);
console.log(`[MultiFlood] Total rate: ~${(MESSAGE_SIZE_KB * MESSAGES_PER_SECOND * NUM_SESSIONS / 1024).toFixed(2)} MB/sec`);
console.log('');

const message = generateMessage(MESSAGE_SIZE_KB);
const messageBytes = Buffer.byteLength(message);

// 각 세션에 라운드 로빈으로 메시지 전송
let currentSession = 0;
const intervalMs = 1000 / (MESSAGES_PER_SECOND * NUM_SESSIONS);

const interval = setInterval(async () => {
  try {
    const streamKey = `llm:response:stress-session-${currentSession}`;
    await redis.xadd(streamKey, '*', 'data', message);

    totalSent++;
    totalBytes += messageBytes;
    currentSession = (currentSession + 1) % NUM_SESSIONS;

    if (totalSent % 1000 === 0) {
      console.log(
        `[MultiFlood] Sent: ${totalSent} messages, ` +
        `Total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`
      );
    }
  } catch (err) {
    console.error('[MultiFlood] Error:', err);
  }
}, Math.max(1, intervalMs));

setInterval(() => {
  console.log(
    `[MultiFlood] Status - Messages: ${totalSent}, ` +
    `Data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB, ` +
    `Rate: ${(totalSent / (Date.now() / 1000)).toFixed(0)}/sec`
  );
}, 5000);

process.on('SIGINT', () => {
  console.log('\n[MultiFlood] Stopping...');
  console.log(`[MultiFlood] Final - Messages: ${totalSent}, Data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  clearInterval(interval);
  redis.disconnect();
  process.exit(0);
});
