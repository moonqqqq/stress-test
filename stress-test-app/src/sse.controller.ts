import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RedisService } from './redis.service';

@Controller('sse')
export class SseController {
  constructor(private readonly redisService: RedisService) {}

  @Get('chat/:sessionId')
  async chat(
    @Param('sessionId') sessionId: string,
    @Res() res: Response,
  ): Promise<void> {
    console.log(`[SSE] Client connected: ${sessionId}`);

    // SSE 헤더 설정
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const streamKey = `llm:response:${sessionId}`;
    const reader = this.redisService.createReader();
    let lastId = '$'; // 새 메시지만 읽기
    let running = true;

    // 외부 시스템에 요청 전달
    this.redisService.publish('llm:request', JSON.stringify({ sessionId }));

    // 클라이언트 연결 종료 처리
    res.on('close', () => {
      console.log(`[SSE] Client disconnected: ${sessionId}`);
      running = false;
      reader.disconnect();
    });

    // 백프레셔를 고려한 스트리밍 루프
    const streamLoop = async () => {
      while (running) {
        try {
          // Redis에서 메시지 읽기 (블로킹)
          const message = await this.redisService.xreadOne(
            reader,
            streamKey,
            lastId,
            5000, // 5초 블로킹
          );

          if (!running) break;

          if (message) {
            lastId = message.id;

            // SSE 형식으로 데이터 전송
            const sseData = `data: ${message.data}\n\n`;

            // res.write() 반환값으로 백프레셔 감지
            const canContinue = res.write(sseData);

            if (!canContinue) {
              // 버퍼가 가득 참 - drain 이벤트 대기
              console.log(`[SSE] Backpressure detected for ${sessionId}, waiting for drain...`);
              await new Promise<void>((resolve) => {
                res.once('drain', () => {
                  console.log(`[SSE] Drain event received for ${sessionId}`);
                  resolve();
                });
              });
            }
          }
        } catch (err) {
          if (running) {
            console.error(`[SSE] Error for ${sessionId}:`, err);
          }
          break;
        }
      }

      // 정리
      if (!res.writableEnded) {
        res.end();
      }
      reader.disconnect();
      console.log(`[SSE] Stream ended for ${sessionId}`);
    };

    // 스트리밍 시작
    streamLoop();
  }
}
