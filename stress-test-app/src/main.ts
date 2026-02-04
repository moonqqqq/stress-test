import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 메모리 사용량 모니터링 (1초마다)
  setInterval(() => {
    const memUsage = process.memoryUsage();
    console.log('=== Memory Monitor ===');
    console.log(`Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    console.log(`Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
    console.log(`RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
    console.log(`External: ${Math.round(memUsage.external / 1024 / 1024)}MB`);
    console.log('======================');
  }, 1000);

  await app.listen(process.env.PORT ?? 3000);
  console.log(`Server running on port ${process.env.PORT ?? 3000}`);
  console.log('SSE Endpoints:');
  console.log('  - http://localhost:3000/sse/stream (10MB per event)');
  console.log('  - http://localhost:3000/sse/stream-extreme (50MB per event)');
}
bootstrap();
