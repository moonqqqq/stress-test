import { Controller, Post, Body, Get, Param, Sse } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
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
      }
    );

    return {
      jobId,
      message: 'Research started',
      streamUrl: `/research/stream/${jobId}`,
    };
  }
  

  /**
   * SSE로 실시간 결과 스트리밍
   * GET /research/stream/:jobId
   */
  @Sse('stream/:jobId')
  streamResults(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      this.streamService.subscribe(jobId, (data) => {
        subscriber.next({ data: JSON.stringify(data) } as MessageEvent);

        if (data.status === 'completed' || data.status === 'error') {
          subscriber.complete();
        }
      });
    });
  }

  /**
   * 스트림 데이터 직접 확인 (디버깅용)
   * GET /research/history/:jobId
   */
  @Get('history/:jobId')
  async getHistory(@Param('jobId') jobId: string) {
    return this.streamService.getHistory(jobId);
  }
}
