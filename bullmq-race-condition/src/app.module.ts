import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ResearchController } from './research.controller';
import { ResearchProcessor } from './research.processor';
import { StreamService } from './stream.service';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: 'localhost',
        port: 6379,
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
  providers: [ResearchProcessor, StreamService],
})
export class AppModule {}
