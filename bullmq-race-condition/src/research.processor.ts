import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { StreamService } from './stream.service';
import { FencingTokenManager } from './fencing-token.manager';

const LOCK_DURATION_MS = 30000;
const STALLED_INTERVAL_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 10000;
const SIMULATION_STEP_DELAY_MS = 2000;

interface JobContext {
  jobId: string;
  token: string;
  signal: AbortSignal;
}

@Processor('deep-research', {
  lockDuration: LOCK_DURATION_MS,
  stalledInterval: STALLED_INTERVAL_MS,
  maxStalledCount: 1,
  concurrency: 1,
})
export class ResearchProcessor extends WorkerHost {
  private readonly workerId = Math.random().toString(36).substring(7);
  private readonly LLM_SERVER_URL = process.env.LLM_SERVER_URL || '';

  // 중복 실행 방지용 (jobId만 추적)
  private runningJobs = new Set<string>();

  constructor(
    private readonly streamService: StreamService,
    private readonly fencingTokenManager: FencingTokenManager,
  ) {
    super();
    console.log(`🔧 Worker: ${this.workerId}`);
  }

  async process(job: Job<{ query: string; jobId: string }>) {
    const { query, jobId } = job.data;

    if (this.runningJobs.has(jobId)) {
      throw new UnrecoverableError('Job already running');
    }
    this.runningJobs.add(jobId);

    const abortController = new AbortController();
    const token = await this.fencingTokenManager.acquire(jobId, this.workerId);

    console.log(`🚀 [${this.workerId}] Start: ${jobId}`);

    // heartbeat: lock 연장 + 토큰 검증
    const heartbeatInterval = setInterval(async () => {
      const lockOk = await this.tryExtendLock(job);
      if (!lockOk) {
        abortController.abort();
        return;
      }

      const tokenOk = await this.fencingTokenManager.validate(jobId, token);
      if (!tokenOk) {
        console.log(`🚫 [${this.workerId}] Token invalid`);
        abortController.abort();
      }
    }, HEARTBEAT_INTERVAL_MS);

    const ctx: JobContext = { jobId, token, signal: abortController.signal };

    try {
      await this.publish(ctx, 'started', { attempt: job.attemptsMade + 1 });

      const result = await this.executeResearch(query, ctx);

      await this.publish(ctx, 'completed', { query, summary: result.summary });
      await this.fencingTokenManager.release(jobId, token);

      console.log(`✅ [${this.workerId}] Done: ${jobId}`);
      return result;

    } catch (error) {
      if (ctx.signal.aborted) {
        console.log(`🧟 [${this.workerId}] Zombie terminated: ${jobId}`);
        throw new UnrecoverableError('Zombie terminated');
      }

      await this.publish(ctx, 'error', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      throw error;

    } finally {
      clearInterval(heartbeatInterval);
      this.runningJobs.delete(jobId);
    }
  }

  // --- 단일 책임 함수들 ---

  /** lock 연장만 수행. 성공 여부 반환 */
  private async tryExtendLock(job: Job): Promise<boolean> {
    try {
      await job.extendLock(job.token!, LOCK_DURATION_MS);
      return true;
    } catch {
      console.error(`⚠️ [${this.workerId}] Lock extend failed`);
      return false;
    }
  }

  /** 스트림 발행 (abort 시 throw) */
  private async publish(
    ctx: JobContext,
    status: string,
    data: Record<string, any> = {}
  ): Promise<void> {
    if (ctx.signal.aborted) throw new UnrecoverableError('Aborted');

    await this.streamService.publish(ctx.jobId, {
      status,
      workerId: this.workerId,
      timestamp: new Date().toISOString(),
      ...data,
    }, ctx.token);
  }

  /** 인터럽트 가능한 딜레이 */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new UnrecoverableError('Aborted'));
      }, { once: true });
    });
  }

  // --- 비즈니스 로직 ---

  private async executeResearch(
    query: string,
    ctx: JobContext
  ): Promise<{ summary: string }> {
    if (this.LLM_SERVER_URL) {
      return this.callLLM(query, ctx);
    }
    return this.simulate(query, ctx);
  }

  private async callLLM(
    query: string,
    ctx: JobContext
  ): Promise<{ summary: string }> {
    const response = await fetch(this.LLM_SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, jobId: ctx.jobId }),
      signal: ctx.signal,
    });

    if (!response.ok) throw new Error(`LLM error: ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No body');

    const decoder = new TextDecoder();
    let summary = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));

          await this.publish(ctx, 'progress', {
            percent: data.percent,
            message: data.message,
          });

          if (data.summary) summary = data.summary;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { summary: summary || `Done: ${query}` };
  }

  private async simulate(
    query: string,
    ctx: JobContext
  ): Promise<{ summary: string }> {
    const steps = [
      { percent: 10, message: '수집 중...' },
      { percent: 25, message: '1차 분석...' },
      { percent: 50, message: '심층 분석...' },
      { percent: 75, message: '종합 중...' },
      { percent: 90, message: '작성 중...' },
      { percent: 100, message: '완료' },
    ];

    for (const step of steps) {
      await this.publish(ctx, 'progress', {
        percent: step.percent,
        message: step.message,
      });
      await this.delay(SIMULATION_STEP_DELAY_MS, ctx.signal);
    }

    return { summary: `Done: ${query}` };
  }
}
