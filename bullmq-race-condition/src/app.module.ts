import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ResearchController } from './research.controller';
import { ResearchProcessor } from './research.processor';
import { StreamService } from './stream.service';
import { FencingTokenManager } from './fencing-token.manager';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
      },
    }),
    BullModule.registerQueue({
      name: 'deep-research',
      defaultJobOptions: {
        attempts: 3,  // 최대 3번 재시도
        backoff: {
          type: 'fixed',
          delay: 1000,  // 1초 후 재시도
        },
      },
    }),
  ],
  controllers: [ResearchController],
  providers: [ResearchProcessor, StreamService, FencingTokenManager],
})
export class AppModule {}
