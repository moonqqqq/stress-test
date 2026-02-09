/**
 * 🚨 Stalled Job을 감지하고 가져가는 별도 Worker
 *
 * 이 worker는 짧은 stalledInterval로 stalled job을 빠르게 감지하고
 * 재처리를 시작합니다.
 *
 * 원본 worker가 아직 실행 중인 상태에서 이 worker가 같은 job을
 * 처리하면 중복 실행이 발생합니다.
 */
import 'reflect-metadata';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379 });
const workerId = `stalled-${Math.random().toString(36).substring(7)}`;

console.log(`\n🔧 Stalled Worker started: ${workerId}`);
console.log(`   - stalledInterval: 2000ms`);
console.log(`   - lockDuration: 3000ms\n`);

const worker = new Worker(
  'deep-research',
  async (job: Job) => {
    const { query, jobId } = job.data;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 [${workerId}] STALLED WORKER picked up job: ${jobId}`);
    console.log(`⏰ Attempt: ${job.attemptsMade + 1}`);
    console.log(`${'='.repeat(50)}\n`);

    // Redis Stream에 시작 알림
    await publishToStream(jobId, {
      status: 'started',
      workerId,
      attempt: job.attemptsMade + 1,
      message: '🚨 STALLED WORKER TOOK OVER',
      timestamp: new Date().toISOString(),
    });

    const steps = [
      'Searching documents...',
      'Analyzing content...',
      'Generating insights...',
      'Compiling results...',
      'Finalizing report...',
    ];

    for (let i = 0; i < steps.length; i++) {
      console.log(`📍 [${workerId}] Step ${i + 1}: ${steps[i]}`);

      await publishToStream(jobId, {
        status: 'progress',
        workerId,
        step: i + 1,
        totalSteps: steps.length,
        message: `🚨 STALLED: ${steps[i]}`,
        timestamp: new Date().toISOString(),
      });

      await sleep(2000);
    }

    const result = {
      status: 'completed',
      workerId,
      query,
      result: `🚨 STALLED WORKER completed: ${workerId}`,
      timestamp: new Date().toISOString(),
    };

    await publishToStream(jobId, result);
    console.log(`\n✅ [${workerId}] Job completed: ${jobId}\n`);

    return result;
  },
  {
    connection: { host: 'localhost', port: 6379 },
    // 🚨 매우 짧은 설정으로 빠르게 stalled 감지
    lockDuration: 3000,      // 3초
    stalledInterval: 2000,   // 2초마다 체크
    maxStalledCount: 3,      // 3번까지 stalled 허용
  }
);

async function publishToStream(jobId: string, data: any) {
  const streamKey = `research:${jobId}`;
  console.log(`📤 [${workerId}] Publishing:`, JSON.stringify({ status: data.status, step: data.step || 'N/A' }));
  await redis.xadd(streamKey, '*', 'data', JSON.stringify(data));
  await redis.publish(streamKey, JSON.stringify(data));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

worker.on('error', (err) => console.error('Worker error:', err));
console.log('🎯 Stalled worker listening for stalled jobs...\n');
