import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

interface StreamData {
  status: string;
  workerId: string;
  fencingToken?: string;
  [key: string]: any;
}

interface FencingTokenInfo {
  token: string;
  workerId: string;
  createdAt: number;
}

@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private publisher: Redis;
  private subscriber: Redis;
  private subscriptions = new Map<string, ((data: StreamData) => void)[]>();

  // 펜싱 토큰 TTL (초) - job이 완료되거나 취소될 때까지 유효
  private readonly FENCING_TOKEN_TTL = 3600; // 1시간

  async onModuleInit() {
    this.publisher = new Redis({ host: 'localhost', port: 6379 });
    this.subscriber = new Redis({ host: 'localhost', port: 6379 });

    console.log('📡 Stream service initialized with fencing token support');

    this.startListening();
  }

  async onModuleDestroy() {
    await this.publisher.quit();
    await this.subscriber.quit();
  }

  /**
   * 펜싱 토큰 발급
   *
   * 새로운 job 처리가 시작될 때 호출됩니다.
   * 이전 토큰을 무효화하고 새 토큰을 발급합니다.
   */
  async acquireFencingToken(jobId: string, workerId: string): Promise<string> {
    const tokenKey = `fencing:${jobId}`;
    const token = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    const tokenInfo: FencingTokenInfo = {
      token,
      workerId,
      createdAt: Date.now(),
    };

    // 원자적으로 새 토큰 설정 (이전 토큰 자동 무효화)
    await this.publisher.set(
      tokenKey,
      JSON.stringify(tokenInfo),
      'EX',
      this.FENCING_TOKEN_TTL
    );

    console.log(`🔐 [${workerId}] Acquired fencing token: ${token.substring(0, 8)}...`);

    return token;
  }

  /**
   * 펜싱 토큰 검증
   *
   * 스트림에 쓰기 전에 현재 토큰이 유효한지 확인합니다.
   */
  async validateFencingToken(jobId: string, token: string): Promise<boolean> {
    const tokenKey = `fencing:${jobId}`;
    const storedData = await this.publisher.get(tokenKey);

    if (!storedData) {
      return false;
    }

    const tokenInfo: FencingTokenInfo = JSON.parse(storedData);
    return tokenInfo.token === token;
  }

  /**
   * 펜싱 토큰 해제 (job 완료 시)
   */
  async releaseFencingToken(jobId: string, token: string): Promise<void> {
    const tokenKey = `fencing:${jobId}`;

    // 토큰이 일치하는 경우에만 삭제 (Lua script로 원자적 처리)
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

    await this.publisher.eval(script, 1, tokenKey, token);
  }

  /**
   * Redis Stream에 데이터 발행 (검증 없이)
   *
   * 펜싱 토큰 검증은 Lock 갱신 시점에 별도로 수행합니다.
   * 이 방식으로 Redis 호출 빈도를 줄입니다.
   */
  async publish(jobId: string, data: StreamData, fencingToken?: string): Promise<void> {
    const streamKey = `research:${jobId}`;

    // 토큰 정보를 데이터에 포함 (나중에 필터링용)
    const enrichedData = {
      ...data,
      fencingToken: fencingToken ? fencingToken.substring(0, 8) : 'none',
    };

    console.log(
      `📤 [${data.workerId}] Publishing to ${streamKey}:`,
      JSON.stringify({ status: data.status, step: data.step || 'N/A' })
    );

    // 검증 없이 바로 발행 (XADD + PUBLISH)
    await this.publisher.xadd(streamKey, '*', 'data', JSON.stringify(enrichedData));
    await this.publisher.publish(streamKey, JSON.stringify(enrichedData));
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

    this.subscriptions.get(streamKey)!.push(callback);
  }

  /**
   * 스트림 히스토리 조회 (펜싱 토큰 정보 포함)
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
   * 유효한 데이터만 필터링한 히스토리 조회
   */
  async getValidHistory(jobId: string): Promise<any[]> {
    const history = await this.getHistory(jobId);

    // 가장 최근 펜싱 토큰을 가진 데이터만 반환
    const tokenGroups = new Map<string, any[]>();

    for (const entry of history) {
      const token = entry.fencingToken || 'none';
      if (!tokenGroups.has(token)) {
        tokenGroups.set(token, []);
      }
      tokenGroups.get(token)!.push(entry);
    }

    // completed 상태를 가진 그룹 찾기
    for (const [, entries] of tokenGroups) {
      if (entries.some(e => e.status === 'completed')) {
        return entries;
      }
    }

    // 없으면 가장 최근 토큰 그룹 반환
    const tokens = Array.from(tokenGroups.keys()).sort().reverse();
    return tokens.length > 0 ? tokenGroups.get(tokens[0])! : [];
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
