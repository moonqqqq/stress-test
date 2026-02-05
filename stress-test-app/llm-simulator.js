const Redis = require('ioredis');

const subscriber = new Redis();
const publisher = new Redis();

const LLM_RESPONSE = `안녕하세요! 저는 AI 어시스턴트입니다.
오늘 무엇을 도와드릴까요?
코딩, 글쓰기, 분석 등 다양한 작업을 도와드릴 수 있습니다.
궁금한 점이 있으시면 편하게 물어보세요!`;

subscriber.subscribe('llm:request', (err) => {
  if (err) {
    console.error('Subscribe error:', err);
    return;
  }
  console.log('[LLM Simulator] Listening for requests...');
});

subscriber.on('message', async (channel, message) => {
  const { sessionId } = JSON.parse(message);
  console.log(`[LLM Simulator] Request received: ${sessionId}`);

  const responseChannel = `llm:response:${sessionId}`;
  const tokens = LLM_RESPONSE.split('');

  // 토큰 단위로 스트리밍 (50ms 간격)
  for (const token of tokens) {
    await new Promise((r) => setTimeout(r, 50));
    publisher.publish(responseChannel, JSON.stringify({ token }));
  }

  // 완료 신호
  publisher.publish(responseChannel, JSON.stringify({ done: true }));
  console.log(`[LLM Simulator] Response complete: ${sessionId}`);
});

console.log('[LLM Simulator] Started');
