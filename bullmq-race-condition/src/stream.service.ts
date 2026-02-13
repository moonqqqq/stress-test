import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');

interface StreamData {
  status: string;
  workerId: string;
  fencingToken?: number;
  [key: string]: any;
}

/**
 * 스트림 서비스
 * Redis Stream 발행/구독만 담당합니다.
 */
@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private publisher: Redis;
  private subscriber: Redis;
  private subscriptions = new Map<string, ((data: StreamData) => void)[]>();

  async onModuleInit() {
    this.publisher = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    this.subscriber = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

    console.log('📡 Stream service initialized');
    this.startListening();
  }

  async onModuleDestroy() {
    await this.publisher.quit();
    await this.subscriber.quit();
  }

  /**
   * 스트림에 데이터 발행
   */
  async publish(jobId: string, data: StreamData, fencingToken?: number): Promise<void> {
    const streamKey = `research:${jobId}`;

    const enrichedData = {
      ...data,
      fencingToken: fencingToken ?? 0,
    };

    console.log(
      `📤 [${data.workerId}] Publishing: ${data.status}`
    );

    await this.publisher.xadd(streamKey, '*', 'data', JSON.stringify(enrichedData));
    await this.publisher.publish(streamKey, JSON.stringify(enrichedData));
  }

  /**
   * 스트림 구독. 해제 함수 반환.
   */
  subscribe(jobId: string, callback: (data: StreamData) => void): () => void {
    const streamKey = `research:${jobId}`;

    if (!this.subscriptions.has(streamKey)) {
      this.subscriptions.set(streamKey, []);
      this.subscriber.subscribe(streamKey);
    }

    this.subscriptions.get(streamKey)!.push(callback);

    // 구독 해제 함수 반환
    return () => {
      const callbacks = this.subscriptions.get(streamKey);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) callbacks.splice(index, 1);

        if (callbacks.length === 0) {
          this.subscriptions.delete(streamKey);
          this.subscriber.unsubscribe(streamKey);
        }
      }
    };
  }

  /**
   * 히스토리 조회
   */
  async getHistory(jobId: string): Promise<any[]> {
    const streamKey = `research:${jobId}`;
    const entries = await this.publisher.xrange(streamKey, '-', '+');

    return entries.map(([id, fields]) => ({
      streamId: id,
      ...JSON.parse(fields[1]),
    }));
  }

  /**
   * 유효한 히스토리만 조회 (최신 토큰 기준)
   */
  async getValidHistory(jobId: string): Promise<any[]> {
    const history = await this.getHistory(jobId);

    const tokenGroups = new Map<number, any[]>();

    for (const entry of history) {
      const token = entry.fencingToken ?? 0;
      if (!tokenGroups.has(token)) {
        tokenGroups.set(token, []);
      }
      tokenGroups.get(token)!.push(entry);
    }

    // completed 상태 그룹 우선
    for (const [, entries] of tokenGroups) {
      if (entries.some(e => e.status === 'completed')) {
        return entries;
      }
    }

    // 없으면 최신 토큰 그룹 (숫자 내림차순)
    const tokens = Array.from(tokenGroups.keys()).sort((a, b) => b - a);
    return tokens.length > 0 ? tokenGroups.get(tokens[0])! : [];
  }

  private startListening(): void {
    this.subscriber.on('message', (channel, message) => {
      const callbacks = this.subscriptions.get(channel);
      if (callbacks) {
        const data = JSON.parse(message);
        callbacks.forEach((cb) => cb(data));
      }
    });
  }
}
