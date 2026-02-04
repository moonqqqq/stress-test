import { Controller, Sse, Query, MessageEvent, OnModuleInit } from '@nestjs/common';
import { Observable, interval, map, tap, ReplaySubject, takeWhile } from 'rxjs';

@Controller('sse')
export class SseController implements OnModuleInit {
  private connectionCount = 0;

  // Redis Pub/Sub 시뮬레이션 - 외부에서 계속 데이터를 푸시
  // ReplaySubject: 버퍼에 모든 이벤트를 저장 → OOM 발생!
  private redisPubSub$ = new ReplaySubject<MessageEvent>(Infinity);
  private redisSimulatorRunning = false;

  // 서버 시작 시 바로 Redis 시뮬레이터 시작 (구독자 없어도 데이터 쌓임)
  onModuleInit() {
    console.log('[SseController] Starting Redis simulator on server init...');
    this.startRedisSimulator();
  }

  /**
   * Backpressure를 무시하고 데이터를 계속 보내는 SSE 엔드포인트
   * @Sse 데코레이터를 사용한 RxJS Observable 기반 구현
   */
  @Sse('stream')
  stream(
    @Query('chunkSize') chunkSizeKB: string = '1024', // 기본 1MB
    @Query('interval') intervalMs: string = '10', // 기본 10ms
  ): Observable<MessageEvent> {
    const connectionId = ++this.connectionCount;
    const chunkSize = parseInt(chunkSizeKB) * 1024; // KB to bytes
    const intervalTime = parseInt(intervalMs);

    console.log(
      `[${connectionId}] New connection - Chunk: ${chunkSizeKB}KB, Interval: ${intervalMs}ms`,
    );

    let eventCount = 0;
    let totalBytesSent = 0;
    let isActive = true;

    // 큰 데이터 청크 생성 (한 번만 생성하여 재사용)
    const payload = 'x'.repeat(chunkSize);

    return interval(intervalTime).pipe(
      takeWhile(() => isActive),
      map(() => {
        eventCount++;
        const data = {
          event: eventCount,
          size: chunkSize,
          timestamp: Date.now(),
          payload: payload,
        };

        totalBytesSent += JSON.stringify(data).length;

        return { data } as MessageEvent;
      }),
      tap(() => {
        // 메모리 상태 로깅 (매 100개 이벤트마다)
        if (eventCount % 100 === 0) {
          const mem = process.memoryUsage();
          console.log(
            `[${connectionId}] Events: ${eventCount} | ` +
              `Sent: ${Math.round(totalBytesSent / 1024 / 1024)}MB | ` +
              `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB | ` +
              `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`,
          );
        }
      }),
    );
  }

  /**
   * 더 공격적인 버전 - 초고속 전송
   * @Sse 데코레이터를 사용한 RxJS Observable 기반 구현
   */
  @Sse('stream-aggressive')
  streamAggressive(): Observable<MessageEvent> {
    const connectionId = ++this.connectionCount;
    console.log(`[${connectionId}] AGGRESSIVE connection started`);

    let eventCount = 0;
    let totalBytes = 0;

    // 5MB 청크
    const chunkSize = 5 * 1024 * 1024;
    const payload = 'A'.repeat(chunkSize);

    // 1ms 간격으로 이벤트 전송
    return interval(1).pipe(
      map(() => {
        const data = {
          event: eventCount++,
          ts: Date.now(),
          data: payload,
        };

        totalBytes += JSON.stringify(data).length;

        return { data } as MessageEvent;
      }),
      tap(() => {
        // 매 10개 이벤트마다 로깅
        if (eventCount % 10 === 0) {
          const mem = process.memoryUsage();
          console.log(
            `[${connectionId}] Blasted ${eventCount} events | ` +
              `Total: ${Math.round(totalBytes / 1024 / 1024)}MB | ` +
              `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB | ` +
              `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`,
          );
        }
      }),
    );
  }

  /**
   * Redis Pub/Sub 시뮬레이션 - Push 기반 데이터 소스
   * 클라이언트가 느려도 데이터가 계속 들어옴 → OOM 발생!
   */
  @Sse('stream-redis')
  streamRedis(): Observable<MessageEvent> {
    const connectionId = ++this.connectionCount;
    console.log(`[${connectionId}] Redis Pub/Sub client connected`);

    // ReplaySubject: 지금까지 쌓인 모든 이벤트 + 새 이벤트를 전달
    // 클라이언트가 느리면 계속 쌓여서 OOM!
    return this.redisPubSub$.asObservable();
  }

  /**
   * Redis에서 데이터가 계속 들어오는 것을 시뮬레이션
   * 1ms마다 1MB 데이터 push
   */
  private startRedisSimulator() {
    this.redisSimulatorRunning = true;
    console.log('[Redis Simulator] Started - pushing 1MB every 1ms');

    const chunkSize = 1024 * 1024; // 1MB
    let eventCount = 0;

    // 이벤트들을 명시적으로 저장하는 배열 (ReplaySubject 대신 직접 관리)
    const eventBuffer: any[] = [];

    const pushData = () => {
      eventCount++;

      // ⚠️ Buffer.alloc으로 실제 메모리 할당 (V8 최적화 우회)
      const payload = Buffer.alloc(chunkSize, eventCount % 256);

      const event = {
        data: {
          event: eventCount,
          source: 'redis-pubsub',
          ts: Date.now(),
          payloadSize: payload.length,
          // payload를 base64로 변환해서 저장 (실제 메모리 사용 보장)
          payload: payload.toString('base64'),
        },
      };

      // 명시적으로 버퍼에 저장 (GC 방지)
      eventBuffer.push(event);

      this.redisPubSub$.next(event as MessageEvent);

      // 매 100개마다 로깅
      if (eventCount % 100 === 0) {
        const mem = process.memoryUsage();
        console.log(
          `[Redis Simulator] Pushed ${eventCount} events | ` +
            `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB | ` +
            `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`,
        );
      }
    };

    // 1ms마다 데이터 push (초당 1000개 × 1MB = 1GB/s)
    setInterval(pushData, 1);
  }
}
