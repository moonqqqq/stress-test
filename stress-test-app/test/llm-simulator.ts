/**
 * LLM 응답 시뮬레이터
 * 실제 LLM처럼 토큰 단위로 스트리밍 응답
 */
import Redis from 'ioredis';

const NUM_SESSIONS = parseInt(process.argv[2] || '100');
const TOKENS_PER_RESPONSE = parseInt(process.argv[3] || '500'); // 응답당 토큰 수
const TOKEN_DELAY_MS = parseInt(process.argv[4] || '20'); // 토큰 간 딜레이 (50 tokens/sec)
const SESSION_PREFIX = process.argv[5] || 'normal-session';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// 실제 LLM 토큰처럼 보이는 텍스트 조각들
const sampleTokens = [
  'The', ' answer', ' to', ' your', ' question', ' is', ' as', ' follows', ':', '\n\n',
  'First', ',', ' let', ' me', ' explain', ' the', ' concept', '.', ' ',
  'This', ' is', ' a', ' fundamental', ' principle', ' in', ' programming', '.',
  ' When', ' you', ' consider', ' the', ' implications', ',', ' it', ' becomes', ' clear', '.',
  '\n\n', 'Here', ' are', ' some', ' key', ' points', ':', '\n',
  '1', '.', ' The', ' first', ' point', ' is', ' about', ' efficiency', '.\n',
  '2', '.', ' The', ' second', ' point', ' relates', ' to', ' scalability', '.\n',
  '3', '.', ' Finally', ',', ' we', ' should', ' consider', ' maintainability', '.\n',
  '\n', 'In', ' conclusion', ',', ' this', ' approach', ' provides', ' a', ' robust', ' solution', '.',
];

interface SessionState {
  sessionId: string;
  tokensSent: number;
  isComplete: boolean;
}

const sessions: Map<string, SessionState> = new Map();
let totalTokensSent = 0;
let completedSessions = 0;

async function sendToken(sessionId: string, token: string): Promise<void> {
  const streamKey = `llm:response:${sessionId}`;
  const message = JSON.stringify({
    type: 'token',
    content: token,
    timestamp: Date.now(),
  });
  await redis.xadd(streamKey, '*', 'data', message);
}

async function simulateSession(sessionId: string): Promise<void> {
  const state: SessionState = {
    sessionId,
    tokensSent: 0,
    isComplete: false,
  };
  sessions.set(sessionId, state);

  for (let i = 0; i < TOKENS_PER_RESPONSE; i++) {
    if (!sessions.has(sessionId)) break;

    const token = sampleTokens[i % sampleTokens.length];
    await sendToken(sessionId, token);

    state.tokensSent++;
    totalTokensSent++;

    await new Promise((r) => setTimeout(r, TOKEN_DELAY_MS));
  }

  // 완료 메시지
  await sendToken(sessionId, '[DONE]');
  state.isComplete = true;
  completedSessions++;
}

async function main() {
  console.log(`[LLM-Simulator] Starting LLM response simulation`);
  console.log(`[LLM-Simulator] Sessions: ${NUM_SESSIONS}`);
  console.log(`[LLM-Simulator] Tokens per response: ${TOKENS_PER_RESPONSE}`);
  console.log(`[LLM-Simulator] Token delay: ${TOKEN_DELAY_MS}ms (~${Math.round(1000 / TOKEN_DELAY_MS)} tokens/sec)`);
  console.log(`[LLM-Simulator] Session prefix: ${SESSION_PREFIX}`);
  console.log('');

  const startTime = Date.now();

  // 모든 세션 동시 시작
  const promises: Promise<void>[] = [];
  for (let i = 0; i < NUM_SESSIONS; i++) {
    const sessionId = `${SESSION_PREFIX}-${i}`;
    promises.push(simulateSession(sessionId));
  }

  // 상태 출력
  const statusInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const tokensPerSec = (totalTokensSent / ((Date.now() - startTime) / 1000)).toFixed(0);
    console.log(
      `[LLM-Simulator] [${elapsed}s] Tokens: ${totalTokensSent}, ` +
      `Completed: ${completedSessions}/${NUM_SESSIONS}, ` +
      `Rate: ${tokensPerSec} tokens/sec`
    );
  }, 5000);

  // 모든 세션 완료 대기
  await Promise.all(promises);

  clearInterval(statusInterval);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log(`[LLM-Simulator] All sessions completed!`);
  console.log(`[LLM-Simulator] Total tokens: ${totalTokensSent}`);
  console.log(`[LLM-Simulator] Total time: ${totalTime}s`);
  console.log(`[LLM-Simulator] Average rate: ${(totalTokensSent / parseFloat(totalTime)).toFixed(0)} tokens/sec`);

  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n[LLM-Simulator] Stopping...');
  sessions.clear();
  redis.disconnect();
  process.exit(0);
});

main().catch(console.error);
