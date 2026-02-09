import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { StreamService } from './stream.service';

@Processor('deep-research', {
  // 🚨 문제를 발생시키는 설정: 매우 짧은 lock
  lockDuration: 3000,      // 3초마다 lock 갱신 필요
  stalledInterval: 2000,   // 2초마다 stalled job 체크
  maxStalledCount: 3,      // 3번 stalled 허용
})
export class ResearchProcessor extends WorkerHost {
  private instanceId = Math.random().toString(36).substring(7);

  constructor(private streamService: StreamService) {
    super();
    console.log(`🔧 Worker instance created: ${this.instanceId}`);
  }

  async process(job: Job<{ query: string; jobId: string }>) {
    const { query, jobId } = job.data;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 [${this.instanceId}] Starting job: ${jobId}`);
    console.log(`📝 Query: ${query}`);
    console.log(`⏰ Attempt: ${job.attemptsMade + 1}`);
    console.log(`${'='.repeat(50)}\n`);

    // Redis Stream에 시작 알림
    await this.streamService.publish(jobId, {
      status: 'started',
      workerId: this.instanceId,
      attempt: job.attemptsMade + 1,
      timestamp: new Date().toISOString(),
    });

    // 🚨 문제 시뮬레이션: 오래 걸리는 작업
    // 각 단계가 2초씩 걸림 = 총 10초
    // lockDuration(5초)보다 오래 걸려서 중간에 lock이 풀림
    const steps = [
      'Searching documents...',
      'Analyzing content...',
      'Generating insights...',
      'Compiling results...',
      'Finalizing report...',
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      console.log(`📍 [${this.instanceId}] Step ${i + 1}: ${step}`);

      // 각 단계 진행상황을 Stream에 발행
      await this.streamService.publish(jobId, {
        status: 'progress',
        workerId: this.instanceId,
        step: i + 1,
        totalSteps: steps.length,
        message: step,
        timestamp: new Date().toISOString(),
      });

      // 🚨 핵심 문제: 2초 대기 (lock 갱신 없이)
      // lockDuration이 5초인데, 5단계 * 2초 = 10초 걸림
      // 중간에 lock이 만료되어 BullMQ가 job을 "stalled"로 판단
      await this.simulateLongTask(2000);
    }

    // 완료
    const result = {
      status: 'completed',
      workerId: this.instanceId,
      query,
      result: `Research completed by worker ${this.instanceId}`,
      timestamp: new Date().toISOString(),
    };

    await this.streamService.publish(jobId, result);

    console.log(`\n✅ [${this.instanceId}] Job completed: ${jobId}\n`);

    return result;
  }

  /**
   * 🚨 문제의 핵심: Lock을 갱신하지 않는 긴 작업
   *
   * 실제 딥리서치에서는 외부 API 호출, 크롤링 등이 이에 해당
   * BullMQ는 lockDuration 내에 job.updateProgress() 등을 호출해야
   * lock이 갱신되는데, 이를 하지 않으면 stalled 처리됨
   */
  private simulateLongTask(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
