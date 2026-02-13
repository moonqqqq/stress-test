import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const TOKEN_TTL_SECONDS = 3600;

/**
 * 펜싱 토큰 관리자
 * 숫자 기반 단조 증가 토큰으로 동시성 제어
 */
@Injectable()
export class FencingTokenManager implements OnModuleDestroy {
  private redis: Redis;

  constructor() {
    this.redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  }

  private getTokenKey(jobId: string): string {
    return `fencing:token:${jobId}`;
  }

  /**
   * 새 토큰 발급 (단조 증가, 이전 토큰 자동 무효화)
   */
  async acquire(jobId: string): Promise<number> {
    const tokenKey = this.getTokenKey(jobId);
    const token = await this.redis.incr(tokenKey);
    await this.redis.expire(tokenKey, TOKEN_TTL_SECONDS);
    return token;
  }

  /**
   * 토큰 유효성 검증 (크기 비교)
   */
  async validate(jobId: string, token: number): Promise<boolean> {
    const currentToken = await this.redis.get(this.getTokenKey(jobId));
    if (!currentToken) return false;

    return token >= parseInt(currentToken, 10);
  }

  /**
   * 토큰 해제 (본인 토큰이 현재 유효한 경우만 삭제)
   */
  async release(jobId: string, token: number): Promise<void> {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if current and tonumber(ARGV[1]) >= tonumber(current) then
        redis.call('DEL', KEYS[1])
        return 1
      end
      return 0
    `;

    await this.redis.eval(script, 1, this.getTokenKey(jobId), token);
  }

  /**
   * 현재 토큰 조회 (프론트엔드 동기화용)
   */
  async getCurrentToken(jobId: string): Promise<number | null> {
    const token = await this.redis.get(this.getTokenKey(jobId));
    return token ? parseInt(token, 10) : null;
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
