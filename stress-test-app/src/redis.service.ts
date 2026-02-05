import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable } from 'rxjs';
import Redis from 'ioredis';

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

  // Redis Streams: XADD
  async addToStream(streamKey: string, message: string): Promise<string> {
    const id = await this.redis.xadd(streamKey, '*', 'data', message);
    return id;
  }

  // Redis Streams: XREAD (blocking)
  readStream(streamKey: string): Observable<string> {
    return new Observable((observer) => {
      const reader = this.redis.duplicate();
      let running = true;
      let lastId = '$'; // 새 메시지만 읽기

      const read = async () => {
        while (running) {
          try {
            // XREAD BLOCK 5000: 5초 동안 새 메시지 대기
            const result = await reader.xread(
              'BLOCK',
              5000,
              'STREAMS',
              streamKey,
              lastId,
            );

            if (result && result.length > 0) {
              const [, messages] = result[0];
              for (const [id, fields] of messages) {
                lastId = id;
                // fields = ['data', 'actual_message']
                const dataIndex = fields.indexOf('data');
                if (dataIndex !== -1) {
                  observer.next(fields[dataIndex + 1]);
                }
              }
            }
          } catch (err) {
            if (running) {
              observer.error(err);
            }
            break;
          }
        }
      };

      console.log(`[Redis] Started reading stream: ${streamKey}`);
      read();

      return () => {
        console.log(`[Redis] Stopped reading stream: ${streamKey}`);
        running = false;
        reader.disconnect();
      };
    });
  }

  // Pub/Sub 호환용 (요청 전달용)
  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(channel, message);
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
