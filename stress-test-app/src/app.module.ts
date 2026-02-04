import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SseController } from './sse.controller';

@Module({
  imports: [],
  controllers: [AppController, SseController],
  providers: [AppService],
})
export class AppModule {}
