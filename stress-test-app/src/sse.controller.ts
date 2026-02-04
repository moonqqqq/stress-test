import { Controller, Sse, Query, Param, MessageEvent, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

@Controller('sse')
export class SseController implements OnModuleInit {
  private connectionCount = 0;

  // 채널별 Redis Pub/Sub 구독 시뮬레이션
  // 각 채널(id)마다 Subject를 생성하여 데이터를 push
  private channels: Map<string, Subject<MessageEvent>> = new Map();

  // 연결된 클라이언트 수 추적
  private activeClients: Set<number> = new Set();

  onModuleInit() {
    console.log('[SseController] Server started');
    console.log('[SseController] Waiting for client subscriptions...');
  }

  /**
   * 채널 구독 엔드포인트
   * GET /sse/subscribe/:id
   *
   * 클라이언트가 특정 채널을 구독하면:
   * 1. 해당 채널이 없으면 생성 + Redis 시뮬레이터 시작
   * 2. 클라이언트별 버퍼 생성
   * 3. 채널 데이터를 SSE로 전송
   */
  @Sse('subscribe/:id')
  subscribe(
    @Param('id') channelId: string,
    @Query('bufferSize') bufferSizeKB: string = '1024', // 기본 1MB per message
    @Query('interval') intervalMs: string = '10', // 기본 10ms
  ): Observable<MessageEvent> {
    const connectionId = ++this.connectionCount;
    const bufferSize = parseInt(bufferSizeKB) * 1024;
    const interval = parseInt(intervalMs);

    console.log(`[Client ${connectionId}] Subscribing to channel: ${channelId}`);
    console.log(`[Client ${connectionId}] Buffer size: ${bufferSizeKB}KB, Interval: ${intervalMs}ms`);

    // 채널이 없으면 생성하고 Redis 시뮬레이터 시작
    if (!this.channels.has(channelId)) {
      this.createChannel(channelId, bufferSize, interval);
    }

    // 해당 채널의 Subject를 구독
    const channel$ = this.channels.get(channelId)!;
    this.activeClients.add(connectionId);

    let eventCount = 0;

    return new Observable<MessageEvent>((observer) => {
      console.log(`[Client ${connectionId}] Connected to channel: ${channelId}`);

      const subscription = channel$.subscribe({
        next: (event) => {
          eventCount++;
          // SSE로 바로 전송 (클라이언트가 느리면 Node.js 내부 write buffer에 쌓임 → OOM!)
          observer.next(event);

          // 로깅
          if (eventCount % 100 === 0) {
            const mem = process.memoryUsage();
            console.log(
              `[Client ${connectionId}] Sent: ${eventCount} events | ` +
              `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB | ` +
              `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`
            );
          }
        },
        error: (err) => observer.error(err),
      });

      // 연결 종료 시 정리
      return () => {
        console.log(`[Client ${connectionId}] Disconnected from channel: ${channelId}`);
        subscription.unsubscribe();
        this.activeClients.delete(connectionId);
      };
    });
  }

  /**
   * 채널 생성 및 Redis Pub/Sub 시뮬레이션 시작
   * 실제로는 Redis에서 데이터가 들어오지만, 여기서는 시뮬레이션
   */
  private createChannel(channelId: string, bufferSize: number, intervalMs: number) {
    console.log(`[Channel ${channelId}] Creating new channel...`);

    // 일반 Subject: 내부 버퍼 없음
    // 하지만 클라이언트가 느리면 Node.js HTTP response의 write buffer에 쌓임 → OOM!
    const channel$ = new Subject<MessageEvent>();
    this.channels.set(channelId, channel$);

    let eventCount = 0;

    // Redis Pub/Sub 시뮬레이션 - 주기적으로 데이터 push
    const pushData = () => {
      eventCount++;

      // 큰 데이터 생성 (Buffer.alloc으로 실제 메모리 할당)
      const payload = Buffer.alloc(bufferSize, eventCount % 256);

      const event: MessageEvent = {
        data: {
          channel: channelId,
          event: eventCount,
          timestamp: Date.now(),
          payloadSize: payload.length,
          payload: payload.toString('base64'),
        },
      };

      channel$.next(event);

      // 매 100개마다 로깅
      if (eventCount % 100 === 0) {
        const mem = process.memoryUsage();
        console.log(
          `[Channel ${channelId}] Pushed ${eventCount} events | ` +
          `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB | ` +
          `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`
        );
      }
    };

    // 주기적으로 데이터 push (클라이언트가 느려도 계속 push → OOM!)
    setInterval(pushData, intervalMs);

    console.log(`[Channel ${channelId}] Redis simulator started - pushing ${bufferSize / 1024}KB every ${intervalMs}ms`);
  }

  /**
   * 현재 상태 확인용 엔드포인트
   */
  @Sse('status')
  status(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((observer) => {
      const interval = setInterval(() => {
        const mem = process.memoryUsage();
        const status = {
          channels: this.channels.size,
          clients: this.activeClients.size,
          heap: Math.round(mem.heapUsed / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
        };
        observer.next({ data: status });
      }, 1000);

      return () => clearInterval(interval);
    });
  }
}
