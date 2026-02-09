# BullMQ Race Condition 문제 재현

## 문제 상황

BullMQ에서 오래 걸리는 작업(딥리서치 등)을 처리할 때, **lock이 만료되면 같은 job이 동시에 여러 worker에서 실행**될 수 있습니다.

```
                    ┌──────────────────────────────────────┐
                    │           Redis Stream                │
                    │  (중복 메시지 발생!)                   │
                    └──────────────────────────────────────┘
                              ▲              ▲
                              │              │
                    ┌─────────┴──┐    ┌──────┴─────┐
                    │  Worker A  │    │  Worker B  │
                    │ (원본 실행) │    │ (재시도)   │
                    └─────────┬──┘    └──────┬─────┘
                              │              │
                              ▼              ▼
                    ┌──────────────────────────────────────┐
                    │           BullMQ Queue               │
                    │  - lockDuration: 5초                 │
                    │  - 작업 시간: 10초                    │
                    │  → Lock 만료로 stalled 처리          │
                    └──────────────────────────────────────┘
```

## 시나리오

1. **Job 시작**: Worker A가 딥리서치 job을 시작
2. **Lock 만료**: 작업이 `lockDuration`(5초)보다 오래 걸려서 lock 만료
3. **Stalled 감지**: BullMQ가 job을 "stalled"로 판단
4. **재시도 시작**: Worker B가 같은 job을 재시도로 시작
5. **중복 실행**: Worker A는 여전히 실행 중, Worker B도 실행 시작
6. **중복 데이터**: 두 worker 모두 Redis Stream에 진행상황 발행

## 실행 방법

### 1. Redis 시작
```bash
docker run -d -p 6379:6379 redis
```

### 2. 서버 시작
```bash
npm start
```

### 3. 테스트 실행
```bash
chmod +x test-race-condition.sh
./test-race-condition.sh
```

## 실제 테스트 결과

아래는 실제 테스트에서 발생한 중복 실행 결과입니다:

```json
[
  { "status": "started",   "workerId": "vndvqr",         "step": null, "time": "14:25:52" },
  { "status": "progress",  "workerId": "vndvqr",         "step": 1,    "time": "14:25:52" },
  { "status": "progress",  "workerId": "vndvqr",         "step": 2,    "time": "14:25:54" },
  { "status": "started",   "workerId": "stalled-5nkulg", "step": null, "time": "14:25:55" },  // 🚨 중복!
  { "status": "progress",  "workerId": "stalled-5nkulg", "step": 1,    "time": "14:25:55" },  // 🚨 중복!
  { "status": "progress",  "workerId": "vndvqr",         "step": 3,    "time": "14:25:56" },
  { "status": "progress",  "workerId": "stalled-5nkulg", "step": 2,    "time": "14:25:57" },  // 🚨 중복!
  { "status": "progress",  "workerId": "vndvqr",         "step": 4,    "time": "14:25:58" },
  { "status": "progress",  "workerId": "stalled-5nkulg", "step": 3,    "time": "14:25:59" },  // 🚨 중복!
  { "status": "progress",  "workerId": "vndvqr",         "step": 5,    "time": "14:26:00" },
  { "status": "progress",  "workerId": "stalled-5nkulg", "step": 4,    "time": "14:26:01" },  // 🚨 중복!
  { "status": "completed", "workerId": "vndvqr",         "step": null, "time": "14:26:02" },  // ✅ 첫 번째 완료
  { "status": "progress",  "workerId": "stalled-5nkulg", "step": 5,    "time": "14:26:03" },  // 🚨 중복!
  { "status": "completed", "workerId": "stalled-5nkulg", "step": null, "time": "14:26:05" }   // 🚨 두 번째 완료!
]
```

**문제점:**
- `started` 이벤트 2번 발생
- `completed` 이벤트 2번 발생
- 모든 step이 2번씩 발생
- 클라이언트가 혼란스러운 데이터를 받음

`GET /research/history/:jobId`로 스트림 히스토리를 조회하면 중복된 메시지를 확인할 수 있습니다.

## 문제의 원인

```typescript
// research.processor.ts
@Processor('deep-research', {
  lockDuration: 5000,    // 🚨 5초
  stalledInterval: 3000, // 🚨 3초마다 체크
})
export class ResearchProcessor {
  async process(job) {
    for (const step of steps) {
      await this.simulateLongTask(2000);  // 🚨 lock 갱신 없이 2초 대기
    }
    // 총 10초 걸림 → lockDuration(5초) 초과
  }
}
```

## 해결 방법

이 리포지토리는 **문제를 재현**하기 위한 것입니다.
해결 방법은 별도 문서에서 다룹니다.
