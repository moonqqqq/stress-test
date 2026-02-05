import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export interface StreamMessage {
  id: string;
  data: string;
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private redis: Redis;

  constructor() {
    const config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    };
    this.redis = new Redis(config);
  }

  // 새로운 Redis 연결 생성 (스트림 리더용)
  createReader(): Redis {
    return this.redis.duplicate();
  }

  // Redis Streams: XADD
  async addToStream(streamKey: string, message: string): Promise<string> {
    const id = await this.redis.xadd(streamKey, '*', 'data', message);
    return id ?? '';
  }

  // Redis Streams: XREAD - 한 번에 하나씩 읽기 (pull 기반)
  async xreadOne(
    reader: Redis,
    streamKey: string,
    lastId: string,
    blockMs: number = 5000,
  ): Promise<StreamMessage | null> {
    // ioredis 타입 정의 문제로 call 사용
    const result = (await reader.call(
      'XREAD',
      'BLOCK',
      blockMs.toString(),
      'COUNT',
      '1',
      'STREAMS',
      streamKey,
      lastId,
    )) as [string, [string, string[]][]][] | null;

    if (result && result.length > 0) {
      const [, messages] = result[0];
      if (messages.length > 0) {
        const [id, fields] = messages[0];
        const dataIndex = fields.indexOf('data');
        if (dataIndex !== -1) {
          return {
            id,
            data: fields[dataIndex + 1],
          };
        }
      }
    }
    return null;
  }

  // Pub/Sub (요청 전달용)
  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(channel, message);
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
