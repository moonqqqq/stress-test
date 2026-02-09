import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

interface StreamData {
  status: string;
  workerId: string;
  [key: string]: any;
}

@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private publisher: Redis;
  private subscriber: Redis;
  private subscriptions = new Map<string, ((data: StreamData) => void)[]>();

  async onModuleInit() {
    this.publisher = new Redis({ host: 'localhost', port: 6379 });
    this.subscriber = new Redis({ host: 'localhost', port: 6379 });

    console.log('📡 Stream service initialized');

    // Redis Stream 구독 시작
    this.startListening();
  }

  async onModuleDestroy() {
    await this.publisher.quit();
    await this.subscriber.quit();
  }

  /**
   * Redis Stream에 데이터 발행
   *
   * 🚨 문제: 여러 worker가 동시에 같은 stream에 쓸 수 있음
   * - Worker A가 step 1, 2, 3 진행 중
   * - Worker B (재시도)가 step 1, 2 진행 시작
   * - 클라이언트는 순서가 뒤섞인 메시지를 받음
   */
  async publish(jobId: string, data: StreamData) {
    const streamKey = `research:${jobId}`;

    // 🚨 문제 시각화: 어떤 worker가 언제 발행하는지 로깅
    console.log(
      `📤 [${data.workerId}] Publishing to ${streamKey}:`,
      JSON.stringify({ status: data.status, step: data.step || 'N/A' })
    );

    // Redis Stream에 추가 (XADD)
    await this.publisher.xadd(
      streamKey,
      '*',  // 자동 ID 생성
      'data', JSON.stringify(data)
    );

    // Pub/Sub으로도 실시간 알림 (SSE용)
    await this.publisher.publish(streamKey, JSON.stringify(data));
  }

  /**
   * 특정 job의 스트림 구독
   */
  subscribe(jobId: string, callback: (data: StreamData) => void) {
    const streamKey = `research:${jobId}`;

    if (!this.subscriptions.has(streamKey)) {
      this.subscriptions.set(streamKey, []);
      this.subscriber.subscribe(streamKey);
    }

    this.subscriptions.get(streamKey).push(callback);
  }

  /**
   * 스트림 히스토리 조회 (문제 확인용)
   *
   * 🚨 여기서 중복된 메시지를 확인할 수 있음
   * - 같은 step이 다른 workerId로 여러 번 나타남
   */
  async getHistory(jobId: string): Promise<any[]> {
    const streamKey = `research:${jobId}`;

    // XRANGE로 전체 히스토리 조회
    const entries = await this.publisher.xrange(streamKey, '-', '+');

    return entries.map(([id, fields]) => ({
      streamId: id,
      ...JSON.parse(fields[1]),  // fields는 ['data', '{...}'] 형태
    }));
  }

  private startListening() {
    this.subscriber.on('message', (channel, message) => {
      const callbacks = this.subscriptions.get(channel);
      if (callbacks) {
        const data = JSON.parse(message);
        callbacks.forEach((cb) => cb(data));
      }
    });
  }
}
