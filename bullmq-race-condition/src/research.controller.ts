import { Controller, Post, Body, Get, Param, Sse } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable, filter } from 'rxjs';
import { StreamService } from './stream.service';

@Controller('research')
export class ResearchController {
  constructor(
    @InjectQueue('deep-research') private researchQueue: Queue,
    private streamService: StreamService,
  ) {}

  /**
   * 딥리서치 작업 시작
   * POST /research/start
   */
  @Post('start')
  async startResearch(@Body() body: { query: string }) {
    const jobId = `research-${Date.now()}`;

    await this.researchQueue.add(
      'deep-research-task',
      {
        query: body.query,
        jobId,
      },
      {
        jobId,
        // 재시도 설정
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        // 중복 job 방지
        removeOnComplete: {
          age: 3600, // 1시간 후 삭제
          count: 100,
        },
        removeOnFail: {
          age: 86400, // 24시간 후 삭제
        },
      }
    );

    return {
      jobId,
      message: 'Research started',
      streamUrl: `/research/stream/${jobId}`,
      historyUrl: `/research/history/${jobId}`,
      validHistoryUrl: `/research/valid-history/${jobId}`,
    };
  }

  /**
   * SSE로 실시간 결과 스트리밍 (펜싱 토큰 기반 필터링)
   * GET /research/stream/:jobId
   *
   * 좀비 프로세스의 데이터는 자동으로 차단되어
   * 클라이언트는 유효한 데이터만 수신합니다.
   */
  @Sse('stream/:jobId')
  streamResults(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      // 현재 유효한 펜싱 토큰 추적
      let currentFencingToken: string | null = null;

      this.streamService.subscribe(jobId, (data) => {
        // 펜싱 토큰 기반 필터링
        if (data.fencingToken && data.fencingToken !== 'none') {
          // 첫 번째 토큰이거나 같은 토큰인 경우만 허용
          if (!currentFencingToken) {
            currentFencingToken = data.fencingToken;
          } else if (data.fencingToken !== currentFencingToken) {
            // 새로운 토큰 = 새로운 worker가 job을 가져감
            // 이전 데이터는 무시하고 새 토큰으로 갱신
            console.log(
              `🔄 Stream: New fencing token detected, switching from ${currentFencingToken} to ${data.fencingToken}`
            );
            currentFencingToken = data.fencingToken;

            // 클라이언트에 리셋 알림 (선택적)
            subscriber.next({
              data: JSON.stringify({
                status: 'reset',
                message: 'New worker took over, previous progress discarded',
                newFencingToken: data.fencingToken,
              }),
            } as MessageEvent);
          }
        }

        subscriber.next({ data: JSON.stringify(data) } as MessageEvent);

        if (data.status === 'completed' || data.status === 'error') {
          subscriber.complete();
        }
      });
    });
  }

  /**
   * 전체 스트림 히스토리 조회 (디버깅용)
   * GET /research/history/:jobId
   *
   * 모든 데이터를 반환합니다 (좀비 프로세스 데이터 포함).
   */
  @Get('history/:jobId')
  async getHistory(@Param('jobId') jobId: string) {
    const history = await this.streamService.getHistory(jobId);

    return {
      jobId,
      totalEntries: history.length,
      history,
      note: 'This includes all data including zombie process data. Use /valid-history for filtered results.',
    };
  }

  /**
   * 유효한 스트림 히스토리만 조회
   * GET /research/valid-history/:jobId
   *
   * 펜싱 토큰 기반으로 유효한 데이터만 반환합니다.
   * 좀비 프로세스의 오염된 데이터는 자동으로 필터링됩니다.
   */
  @Get('valid-history/:jobId')
  async getValidHistory(@Param('jobId') jobId: string) {
    const validHistory = await this.streamService.getValidHistory(jobId);
    const fullHistory = await this.streamService.getHistory(jobId);

    return {
      jobId,
      validEntries: validHistory.length,
      totalEntries: fullHistory.length,
      filteredOut: fullHistory.length - validHistory.length,
      history: validHistory,
    };
  }

  /**
   * Job 상태 조회
   * GET /research/status/:jobId
   */
  @Get('status/:jobId')
  async getJobStatus(@Param('jobId') jobId: string) {
    const job = await this.researchQueue.getJob(jobId);

    if (!job) {
      return {
        jobId,
        status: 'not_found',
      };
    }

    const state = await job.getState();

    return {
      jobId,
      status: state,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      data: job.data,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    };
  }
}
