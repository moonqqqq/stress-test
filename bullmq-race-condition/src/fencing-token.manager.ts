import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const TOKEN_TTL_SECONDS = 3600;

interface FencingTokenInfo {
  token: string;
  workerId: string;
  createdAt: number;
}

/**
 * 펜싱 토큰 관리자
 * 동시성 제어만 담당합니다.
 */
@Injectable()
export class FencingTokenManager implements OnModuleDestroy {
  private redis: Redis;

  constructor() {
    this.redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  }

  private getKey(jobId: string): string {
    return `fencing:${jobId}`;
  }

  /**
   * 새 토큰 발급 (이전 토큰 자동 무효화)
   */
  async acquire(jobId: string, workerId: string): Promise<string> {
    const token = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    const info: FencingTokenInfo = {
      token,
      workerId,
      createdAt: Date.now(),
    };

    await this.redis.set(
      this.getKey(jobId),
      JSON.stringify(info),
      'EX',
      TOKEN_TTL_SECONDS
    );

    return token;
  }

  /**
   * 토큰 유효성 검증
   */
  async validate(jobId: string, token: string): Promise<boolean> {
    const stored = await this.redis.get(this.getKey(jobId));
    if (!stored) return false;

    const info: FencingTokenInfo = JSON.parse(stored);
    return info.token === token;
  }

  /**
   * 토큰 해제 (본인 토큰만 삭제 가능)
   */
  async release(jobId: string, token: string): Promise<void> {
    const script = `
      local stored = redis.call('GET', KEYS[1])
      if stored then
        local info = cjson.decode(stored)
        if info.token == ARGV[1] then
          redis.call('DEL', KEYS[1])
          return 1
        end
      end
      return 0
    `;

    await this.redis.eval(script, 1, this.getKey(jobId), token);
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
