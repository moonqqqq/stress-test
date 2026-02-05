import { Controller, Sse, Param, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { RedisService } from './redis.service';

@Controller('sse')
export class SseController {
  constructor(private readonly redisService: RedisService) {}

  @Sse('chat/:sessionId')
  chat(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
    console.log(`[SSE] Client connected: ${sessionId}`);

    const streamKey = `llm:response:${sessionId}`;

    // 외부 시스템에 요청 전달
    this.redisService.publish('llm:request', JSON.stringify({ sessionId }));

    // Redis Stream에서 메시지 읽기 (XREAD)
    return this.redisService.readStream(streamKey).pipe(
      map((message) => ({ data: message })),
    );
  }
}
