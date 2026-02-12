/**
 * Stalled Job을 처리하는 별도 Worker
 *
 * 펜싱 토큰과 AbortController를 사용하여
 * 좀비 프로세스 없이 안전하게 stalled job을 처리합니다.
 */
import 'reflect-metadata';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379 });
const workerId = `stalled-${Math.random().toString(36).substring(7)}`;

// 펜싱 토큰 TTL (초)
const FENCING_TOKEN_TTL = 3600;

// 활성 job 컨텍스트 관리
interface JobContext {
  abortController: AbortController;
  fencingToken: string;
  lockExtendInterval: ReturnType<typeof setInterval> | null;
  isAborted: boolean;
}

const activeJobs = new Map<string, JobContext>();

console.log(`\n🔧 Stalled Worker started: ${workerId}`);
console.log(`   - lockDuration: 30000ms`);
console.log(`   - stalledInterval: 15000ms`);
console.log(`   - Fencing Token enabled\n`);

/**
 * 펜싱 토큰 획득
 */
async function acquireFencingToken(jobId: string): Promise<string> {
  const tokenKey = `fencing:${jobId}`;
  const token = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

  const tokenInfo = {
    token,
    workerId,
    createdAt: Date.now(),
  };

  await redis.set(tokenKey, JSON.stringify(tokenInfo), 'EX', FENCING_TOKEN_TTL);

  console.log(`🔐 [${workerId}] Acquired fencing token: ${token.substring(0, 8)}...`);
  return token;
}

/**
 * 펜싱 토큰 검증
 */
async function validateFencingToken(jobId: string, token: string): Promise<boolean> {
  const tokenKey = `fencing:${jobId}`;
  const storedData = await redis.get(tokenKey);

  if (!storedData) {
    return false;
  }

  const tokenInfo = JSON.parse(storedData);
  return tokenInfo.token === token;
}

/**
 * 스트림 발행 (검증 없이 - 토큰 검증은 Lock 갱신 시점에 수행)
 */
async function publish(
  jobId: string,
  fencingToken: string,
  data: any
): Promise<void> {
  const streamKey = `research:${jobId}`;

  const enrichedData = {
    ...data,
    fencingToken: fencingToken.substring(0, 8),
  };

  console.log(
    `📤 [${workerId}] Publishing:`,
    JSON.stringify({ status: data.status, step: data.step || 'N/A' })
  );

  await redis.xadd(streamKey, '*', 'data', JSON.stringify(enrichedData));
  await redis.publish(streamKey, JSON.stringify(enrichedData));
}

/**
 * 펜싱 토큰 해제
 */
async function releaseFencingToken(jobId: string, token: string): Promise<void> {
  const tokenKey = `fencing:${jobId}`;

  const script = `
    local stored = redis.call('GET', KEYS[1])
    if stored then
      local info = cjson.decode(stored)
      if info.token == ARGV[1] then
        redis.call('DEL', KEYS[1])
        return 1
      end
    end
    return 0
  `;

  await redis.eval(script, 1, tokenKey, token);
}

/**
 * Lock 자동 갱신 + 펜싱 토큰 검증 (10초마다)
 */
function startLockExtension(
  job: Job,
  jobId: string,
  signal: AbortSignal,
  context: JobContext
): ReturnType<typeof setInterval> {
  const interval = setInterval(async () => {
    if (signal.aborted) {
      clearInterval(interval);
      return;
    }

    try {
      // 1. Lock 연장
      await job.extendLock(job.token!, 30000);
      console.log(`🔄 [${workerId}] Lock extended for: ${jobId}`);

      // 2. 펜싱 토큰 검증
      const isValid = await validateFencingToken(jobId, context.fencingToken);
      if (!isValid) {
        console.log(`🚫 [${workerId}] Fencing token invalidated: ${jobId}`);
        abortJob(jobId, 'Fencing token invalidated');
      }
    } catch (error) {
      console.error(`⚠️ [${workerId}] Failed to extend lock:`, error);
      abortJob(jobId, 'Failed to extend lock');
    }
  }, 10000);

  return interval;
}

/**
 * Job 중단
 */
function abortJob(jobId: string, reason: string) {
  const context = activeJobs.get(jobId);
  if (context && !context.isAborted) {
    console.log(`🛑 [${workerId}] Aborting job: ${jobId} - ${reason}`);
    context.isAborted = true;
    context.abortController.abort();
  }
}

/**
 * Job 정리
 */
function cleanupJob(jobId: string) {
  const context = activeJobs.get(jobId);
  if (context) {
    if (context.lockExtendInterval) {
      clearInterval(context.lockExtendInterval);
    }
    activeJobs.delete(jobId);
    console.log(`🧹 [${workerId}] Cleaned up job context: ${jobId}`);
  }
}

/**
 * 인터럽트 가능한 딜레이
 */
function interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new UnrecoverableError('Delay interrupted by abort'));
      },
      { once: true }
    );
  });
}

// LLM 서버 URL (환경변수로 설정)
const LLM_SERVER_URL = process.env.LLM_SERVER_URL || '';

/**
 * 연구 작업 수행 - LLM 서버 호출 또는 시뮬레이션
 */
async function executeResearch(
  job: Job,
  jobId: string,
  query: string,
  context: JobContext,
  signal: AbortSignal,
  fencingToken: string
): Promise<string> {
  // LLM 서버 URL이 없으면 시뮬레이션 모드
  if (!LLM_SERVER_URL) {
    return executeResearchSimulation(job, jobId, context, signal, fencingToken);
  }

  // 실제 LLM 서버 호출
  return callLLMServer(job, jobId, query, context, signal, fencingToken);
}

/**
 * 실제 LLM 서버 호출 (SSE 스트림)
 */
async function callLLMServer(
  job: Job,
  jobId: string,
  query: string,
  context: JobContext,
  signal: AbortSignal,
  fencingToken: string
): Promise<string> {
  console.log(`🌐 [${workerId}] Calling LLM server: ${LLM_SERVER_URL}`);

  const response = await fetch(LLM_SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, jobId }),
    signal,  // abort() 호출 시 요청 취소됨
  });

  if (!response.ok) {
    throw new Error(`LLM server error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let summary = '';

  try {
    while (true) {
      // abort 체크
      if (signal.aborted || context.isAborted) {
        throw new UnrecoverableError('Job was aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

      for (const line of lines) {
        const data = JSON.parse(line.slice(6));

        console.log(`📍 [${workerId}] LLM progress: ${data.percent}%`);

        // 진행 상황 발행
        if (!context.isAborted) {
          await publish(jobId, fencingToken, {
            status: 'progress',
            workerId,
            percent: data.percent,
            message: data.message,
            timestamp: new Date().toISOString(),
          });
        }

        // BullMQ 진행률 업데이트
        await job.updateProgress(data.percent);

        if (data.summary) {
          summary = data.summary;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return summary || `Research completed for: ${jobId}`;
}

/**
 * 시뮬레이션 모드 (LLM 서버 없을 때)
 */
async function executeResearchSimulation(
  job: Job,
  jobId: string,
  context: JobContext,
  signal: AbortSignal,
  fencingToken: string
): Promise<string> {
  console.log(`🔬 [${workerId}] Simulation mode (no LLM_SERVER_URL)`);

  const steps = [
    { percent: 10, message: '문서 수집 중...' },
    { percent: 25, message: '1차 분석 중...' },
    { percent: 50, message: '심층 분석 중...' },
    { percent: 75, message: '결과 종합 중...' },
    { percent: 90, message: '보고서 작성 중...' },
    { percent: 100, message: '완료' },
  ];

  for (const step of steps) {
    // Abort 체크
    if (signal.aborted || context.isAborted) {
      throw new UnrecoverableError('Job was aborted');
    }

    console.log(`📍 [${workerId}] Progress: ${step.percent}% - ${step.message}`);

    // 진행 상황 발행
    if (!context.isAborted) {
      await publish(jobId, fencingToken, {
        status: 'progress',
        workerId,
        percent: step.percent,
        message: step.message,
        timestamp: new Date().toISOString(),
      });
    }

    // BullMQ 진행률 업데이트
    await job.updateProgress(step.percent);

    // 작업 시뮬레이션 (2초 대기, abort 가능)
    await interruptibleDelay(2000, signal);
  }

  return `Research completed for: ${jobId}`;
}

const worker = new Worker(
  'deep-research',
  async (job: Job) => {
    const { query, jobId } = job.data;

    // 이미 실행 중인 job인지 확인
    if (activeJobs.has(jobId)) {
      console.log(`⚠️ [${workerId}] Job already running: ${jobId}`);
      throw new UnrecoverableError('Job already running in this worker');
    }

    // AbortController 생성
    const abortController = new AbortController();
    const { signal } = abortController;

    // 펜싱 토큰 획득
    const fencingToken = await acquireFencingToken(jobId);

    // Job 컨텍스트 초기화
    const context: JobContext = {
      abortController,
      fencingToken,
      lockExtendInterval: null,
      isAborted: false,
    };

    activeJobs.set(jobId, context);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 [${workerId}] STALLED WORKER picked up job: ${jobId}`);
    console.log(`⏰ Attempt: ${job.attemptsMade + 1}`);
    console.log(`🔐 Fencing Token: ${fencingToken.substring(0, 8)}...`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      // Lock 자동 갱신 + 토큰 검증 시작 (10초마다)
      context.lockExtendInterval = startLockExtension(job, jobId, signal, context);

      // 시작 알림
      await publish(jobId, fencingToken, {
        status: 'started',
        workerId,
        attempt: job.attemptsMade + 1,
        message: 'STALLED WORKER TOOK OVER',
        timestamp: new Date().toISOString(),
      });

      // LLM 서버 호출 또는 시뮬레이션
      const summary = await executeResearch(job, jobId, query, context, signal, fencingToken);

      await publish(jobId, fencingToken, {
        status: 'completed',
        workerId,
        query,
        summary,
        timestamp: new Date().toISOString(),
      });
      await releaseFencingToken(jobId, fencingToken);

      console.log(`\n✅ [${workerId}] Job completed: ${jobId}\n`);

      return { summary };
    } catch (error) {
      if (signal.aborted || context.isAborted) {
        console.log(`🛑 [${workerId}] Job aborted: ${jobId}`);
        throw new UnrecoverableError('Job was aborted - zombie process terminated');
      }

      console.error(`❌ [${workerId}] Job failed: ${jobId}`, error);

      await publish(jobId, fencingToken, {
        status: 'error',
        workerId,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });

      throw error;
    } finally {
      cleanupJob(jobId);
    }
  },
  {
    connection: { host: 'localhost', port: 6379 },
    lockDuration: 30000,      // 30초
    stalledInterval: 15000,   // 15초마다 체크
    maxStalledCount: 1,       // 1번만 stalled 허용
    concurrency: 1,
  }
);

console.log('🎯 Stalled worker listening...\n');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down stalled worker...');

  // 모든 활성 job 중단
  for (const [jobId] of activeJobs) {
    abortJob(jobId, 'Worker shutdown');
  }

  await worker.close();
  await redis.quit();
  process.exit(0);
});
