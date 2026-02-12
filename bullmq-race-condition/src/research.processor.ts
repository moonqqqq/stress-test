import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { StreamService } from './stream.service';

/**
 * Job 실행 컨텍스트
 *
 * AbortController와 펜싱 토큰을 함께 관리하여
 * 좀비 프로세스 감지 및 자동 종료를 처리합니다.
 */
interface JobContext {
  abortController: AbortController;
  fencingToken: string;
  lockExtendInterval: ReturnType<typeof setInterval> | null;
  isAborted: boolean;
}

@Processor('deep-research', {
  // 적절한 lock 설정
  lockDuration: 30000,      // 30초 lock
  stalledInterval: 15000,   // 15초마다 stalled 체크
  maxStalledCount: 1,       // 1번만 stalled 허용 (빠른 감지)
  concurrency: 1,           // 동시 처리 수 (필요에 따라 조정)
})
export class ResearchProcessor extends WorkerHost {
  private readonly instanceId = Math.random().toString(36).substring(7);

  // 활성 job 컨텍스트 관리
  private activeJobs = new Map<string, JobContext>();

  constructor(private readonly streamService: StreamService) {
    super();
    console.log(`🔧 Worker instance created: ${this.instanceId}`);
  }

  /**
   * 메인 job 처리 함수
   */
  async process(job: Job<{ query: string; jobId: string }>) {
    const { query, jobId } = job.data;

    // 이미 이 job이 실행 중인지 확인 (중복 실행 방지)
    if (this.activeJobs.has(jobId)) {
      console.log(`⚠️ [${this.instanceId}] Job already running: ${jobId}`);
      throw new UnrecoverableError('Job already running in this worker');
    }

    // AbortController 생성
    const abortController = new AbortController();
    const { signal } = abortController;

    // 펜싱 토큰 획득 (이전 토큰 자동 무효화)
    const fencingToken = await this.streamService.acquireFencingToken(
      jobId,
      this.instanceId
    );

    // Job 컨텍스트 초기화
    const context: JobContext = {
      abortController,
      fencingToken,
      lockExtendInterval: null,
      isAborted: false,
    };

    this.activeJobs.set(jobId, context);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 [${this.instanceId}] Starting job: ${jobId}`);
    console.log(`📝 Query: ${query}`);
    console.log(`⏰ Attempt: ${job.attemptsMade + 1}`);
    console.log(`🔐 Fencing Token: ${fencingToken.substring(0, 8)}...`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      // Lock 자동 갱신 + 토큰 검증 시작 (10초마다)
      context.lockExtendInterval = this.startLockExtension(job, jobId, signal, context);

      // 시작 알림
      if (!context.isAborted) {
        await this.streamService.publish(jobId, {
          status: 'started',
          workerId: this.instanceId,
          attempt: job.attemptsMade + 1,
          timestamp: new Date().toISOString(),
        }, context.fencingToken);
      }

      // 작업 수행
      const result = await this.executeResearch(job, jobId, query, context, signal);

      // 완료 알림
      if (!context.isAborted) {
        await this.streamService.publish(jobId, {
          status: 'completed',
          workerId: this.instanceId,
          query,
          summary: result.summary,
          timestamp: new Date().toISOString(),
        }, context.fencingToken);
      }

      // 펜싱 토큰 해제
      await this.streamService.releaseFencingToken(jobId, fencingToken);

      console.log(`\n✅ [${this.instanceId}] Job completed: ${jobId}\n`);

      return result;
    } catch (error) {
      // Abort로 인한 에러인지 확인
      if (signal.aborted || context.isAborted) {
        console.log(`🛑 [${this.instanceId}] Job aborted: ${jobId}`);

        // 좀비 프로세스이므로 에러를 발행하지 않음
        throw new UnrecoverableError('Job was aborted - zombie process terminated');
      }

      // 실제 에러 처리
      console.error(`❌ [${this.instanceId}] Job failed: ${jobId}`, error);

      if (!context.isAborted) {
        await this.streamService.publish(jobId, {
          status: 'error',
          workerId: this.instanceId,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        }, context.fencingToken);
      }

      throw error;
    } finally {
      // 정리 작업
      this.cleanupJob(jobId);
    }
  }

  // LLM 서버 URL (환경변수로 설정)
  private readonly LLM_SERVER_URL = process.env.LLM_SERVER_URL || '';

  /**
   * 연구 작업 수행 - LLM 서버 호출
   */
  private async executeResearch(
    job: Job,
    jobId: string,
    query: string,
    context: JobContext,
    signal: AbortSignal
  ): Promise<{ summary: string }> {
    // LLM 서버 URL이 없으면 시뮬레이션 모드
    if (!this.LLM_SERVER_URL) {
      return this.executeResearchSimulation(job, jobId, query, context, signal);
    }

    // 실제 LLM 서버 호출
    return this.callLLMServer(job, jobId, query, context, signal);
  }

  /**
   * 실제 LLM 서버 호출 (SSE 스트림)
   */
  private async callLLMServer(
    job: Job,
    jobId: string,
    query: string,
    context: JobContext,
    signal: AbortSignal
  ): Promise<{ summary: string }> {
    console.log(`🌐 [${this.instanceId}] Calling LLM server: ${this.LLM_SERVER_URL}`);

    const response = await fetch(this.LLM_SERVER_URL, {
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
        this.checkAborted(signal, context);

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = JSON.parse(line.slice(6));

          console.log(`📍 [${this.instanceId}] LLM progress: ${data.percent}%`);

          // 진행 상황 발행
          if (!context.isAborted) {
            await this.streamService.publish(jobId, {
              status: 'progress',
              workerId: this.instanceId,
              percent: data.percent,
              message: data.message,
              timestamp: new Date().toISOString(),
            }, context.fencingToken);
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

    return { summary: summary || `Research completed for: ${query}` };
  }

  /**
   * 시뮬레이션 모드 (LLM 서버 없을 때)
   */
  private async executeResearchSimulation(
    job: Job,
    jobId: string,
    query: string,
    context: JobContext,
    signal: AbortSignal
  ): Promise<{ summary: string }> {
    console.log(`🔬 [${this.instanceId}] Simulation mode (no LLM_SERVER_URL)`);

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
      this.checkAborted(signal, context);

      console.log(`📍 [${this.instanceId}] Progress: ${step.percent}% - ${step.message}`);

      // 진행 상황 발행
      if (!context.isAborted) {
        await this.streamService.publish(jobId, {
          status: 'progress',
          workerId: this.instanceId,
          percent: step.percent,
          message: step.message,
          timestamp: new Date().toISOString(),
        }, context.fencingToken);
      }

      // BullMQ 진행률 업데이트
      await job.updateProgress(step.percent);

      // 작업 시뮬레이션 (2초 대기, abort 가능)
      await this.interruptibleDelay(2000, signal);
    }

    return { summary: `Research completed for: ${query}` };
  }

  /**
   * Lock 자동 갱신 + 펜싱 토큰 검증 (10초마다)
   */
  private startLockExtension(
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
        console.log(`🔄 [${this.instanceId}] Lock extended for: ${jobId}`);

        // 2. 펜싱 토큰 검증 (Lock 갱신 시점에만 수행)
        const isValid = await this.streamService.validateFencingToken(
          jobId,
          context.fencingToken
        );

        if (!isValid) {
          console.log(`🚫 [${this.instanceId}] Fencing token invalidated: ${jobId}`);
          this.abortJob(jobId, 'Fencing token invalidated');
        }
      } catch (error) {
        console.error(`⚠️ [${this.instanceId}] Failed to extend lock:`, error);
        this.abortJob(jobId, 'Failed to extend lock');
      }
    }, 10000); // 10초마다 갱신 + 검증

    return interval;
  }

  /**
   * Job 중단 (좀비 프로세스 종료)
   */
  private abortJob(jobId: string, reason: string) {
    const context = this.activeJobs.get(jobId);
    if (context && !context.isAborted) {
      console.log(`🛑 [${this.instanceId}] Aborting job: ${jobId} - ${reason}`);
      context.isAborted = true;
      context.abortController.abort();
    }
  }

  /**
   * Abort 상태 체크
   */
  private checkAborted(signal: AbortSignal, context: JobContext) {
    if (signal.aborted || context.isAborted) {
      throw new UnrecoverableError('Job was aborted');
    }
  }

  /**
   * 인터럽트 가능한 딜레이
   */
  private interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);

      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new UnrecoverableError('Delay interrupted by abort'));
      }, { once: true });
    });
  }

  /**
   * Job 정리
   */
  private cleanupJob(jobId: string) {
    const context = this.activeJobs.get(jobId);
    if (context) {
      if (context.lockExtendInterval) {
        clearInterval(context.lockExtendInterval);
      }
      this.activeJobs.delete(jobId);
      console.log(`🧹 [${this.instanceId}] Cleaned up job context: ${jobId}`);
    }
  }
}
