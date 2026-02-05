import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable } from 'rxjs';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private subscriber: Redis;
  private publisher: Redis;

  constructor() {
    const config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    };
    this.subscriber = new Redis(config);
    this.publisher = new Redis(config);
  }

  publish(channel: string, message: string): void {
    this.publisher.publish(channel, message);
  }

  subscribe(channelId: string): Observable<string> {
    return new Observable((observer) => {
      const sub = this.subscriber.duplicate();

      sub.subscribe(channelId, (err) => {
        if (err) {
          observer.error(err);
          return;
        }
        console.log(`[Redis] Subscribed to channel: ${channelId}`);
      });

      sub.on('message', (channel, message) => {
        if (channel === channelId) {
          observer.next(message);
        }
      });

      return () => {
        console.log(`[Redis] Unsubscribed from channel: ${channelId}`);
        sub.unsubscribe(channelId);
        sub.disconnect();
      };
    });
  }

  onModuleDestroy() {
    this.subscriber.disconnect();
    this.publisher.disconnect();
  }
}
