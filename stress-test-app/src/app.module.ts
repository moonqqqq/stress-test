import { Module } from '@nestjs/common';
import { SseController } from './sse.controller';
import { RedisService } from './redis.service';

@Module({
  controllers: [SseController],
  providers: [RedisService],
})
export class AppModule {}
