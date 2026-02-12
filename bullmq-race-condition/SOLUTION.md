# BullMQ Race Condition 해결 가이드

## 목차

1. [들어가며: 무슨 문제인가?](#1-들어가며-무슨-문제인가)
2. [문제의 핵심 원인](#2-문제의-핵심-원인)
3. [해결 전략 개요](#3-해결-전략-개요)
4. [전체 시스템 아키텍처](#4-전체-시스템-아키텍처)
5. [상세 동작 흐름](#5-상세-동작-흐름)
6. [핵심 코드 분석](#6-핵심-코드-분석)
7. [시나리오별 동작 설명](#7-시나리오별-동작-설명)
8. [테스트 및 검증](#8-테스트-및-검증)

---

## 1. 들어가며: 무슨 문제인가?

### 1.1 시나리오: AI 딥리서치 서비스

당신은 AI 딥리서치 서비스를 운영하고 있습니다. 사용자가 "AI 기술 동향 분석"을 요청하면:

```
┌──────────┐      ┌──────────┐      ┌─────────────────┐      ┌──────────┐
│ 클라이언트 │ ──▶ │  Worker  │ ──▶ │ 딥리서치 LLM 서버 │ ──▶ │  Redis   │
│          │      │ (BullMQ) │      │   (10분 작업)    │      │  Stream  │
└──────────┘      └──────────┘      └─────────────────┘      └──────────┘
                                            │                      │
                                            │  정기적으로           │
                                            │  진행상황 전송        ▼
                                            └─────────────────▶ 클라이언트
```

**핵심 포인트:**
- Worker는 딥리서치 전용 LLM 서버에 요청을 보냄
- LLM 서버는 **약 10분** 동안 작업 수행
- LLM 서버가 **정기적으로** 진행 상황을 보내줌
- Worker는 받은 진행 상황을 Redis Stream으로 relay

### 1.2 문제 상황

**정상적인 경우:**
```
시간 → (약 10분)

Worker A: ┌── LLM 서버 연결 ─────────────────────────────── 완료 ─┐

LLM 서버 → Redis Stream:
  ▸ started (Worker A)
  ▸ progress: 10% - 문서 수집 중...
  ▸ progress: 25% - 1차 분석 중...
  ▸ progress: 50% - 심층 분석 중...
  ▸ progress: 75% - 결과 종합 중...
  ▸ progress: 90% - 보고서 작성 중...
  ▸ completed ✓

클라이언트: 깔끔하게 순서대로 진행 상황을 받음
```

**문제가 발생하는 경우 (10분 작업 중 Lock 만료):**
```
시간 → (약 10분)

Worker A: ┌── LLM 서버 연결 ──────────────────────────────────────┐
                 │
          [LLM 서버에서 열심히 작업 중...]
          [그런데 Worker A의 Lock이 만료됨!]
                 │
                 ↓
          BullMQ: "Worker A 죽었나?"
          "이 Job을 Worker B에게 넘기자"
                 ↓
Worker B:        ┌── LLM 서버에 새로 연결 ─────────────────────── 완료 ─┐
                 │
Worker A:        [LLM 서버 응답 계속 받는 중...]  ← 좀비 프로세스!
                 [Redis Stream에 계속 발행 중...]

Redis Stream 출력 (대재앙):
  ▸ started (Worker A)
  ▸ progress: 10% (A)
  ▸ progress: 25% (A)
  ▸ started (Worker B)          ← 갑자기 다시 시작?
  ▸ progress: 10% (B)           ← 다시 10%?
  ▸ progress: 50% (A)           ← A가 갑자기 50%?
  ▸ progress: 25% (B)
  ▸ progress: 75% (A)
  ▸ progress: 50% (B)
  ▸ completed (A)               ← A가 완료?
  ▸ progress: 75% (B)
  ▸ completed (B)               ← B도 완료??

클라이언트: 진행률이 왔다갔다... 뭐지???
```

이것이 **Race Condition**입니다.

**10분 작업에서 특히 문제가 되는 이유:**
- BullMQ의 기본 `lockDuration`은 보통 30초~1분
- 10분 작업 동안 Lock을 계속 갱신해야 함
- 네트워크 이슈로 갱신이 한 번만 실패해도 Stalled 처리됨
- 두 Worker가 **동시에 LLM 서버 응답을 받아서** Stream에 발행

---

## 2. 문제의 핵심 원인

### 2.1 BullMQ의 Lock 메커니즘

BullMQ는 Job을 처리할 때 **Lock**을 사용합니다:

```
┌─────────────────────────────────────────────────────────────┐
│  Job: research-123                                          │
│  Lock Owner: Worker A                                       │
│  Lock 만료시간: 2024-01-01 10:00:30 (30초 후)                │
└─────────────────────────────────────────────────────────────┘
```

Worker A가 Job을 가져가면 30초 동안 Lock을 소유합니다.
다른 Worker는 이 Lock이 풀릴 때까지 이 Job을 가져갈 수 없습니다.

### 2.2 Stalled 판정

하지만 Worker A가 **30초 안에 작업을 끝내지 못하면**?

```
시간: 0초 ────────── 15초 ────────── 30초 ────────── 45초
         │            │              │               │
      Job 시작     stalled 체크    Lock 만료!        │
                  "아직 살아있네"   "Worker A 죽었나?" │
                                        ↓            │
                                  Job을 Worker B에게  │
                                  재할당             │
                                        ↓            │
                                  Worker B 시작      │
                                                     │
                                            Worker A는
                                            아직 실행 중!
                                            (좀비 프로세스)
```

**핵심 문제:**
- BullMQ는 Lock이 만료되면 Worker가 죽었다고 판단
- 실제로 Worker는 죽지 않았을 수 있음 (네트워크 지연, 무거운 작업 등)
- 두 Worker가 **동시에 같은 Job을 처리**하게 됨

### 2.3 왜 Lock이 만료되나? (10분 작업의 위험성)

| 원인 | 설명 |
|------|------|
| **작업 시간 자체가 김** | LLM 서버에서 10분 동안 작업 → Lock 갱신 필수 |
| **네트워크 일시 단절** | Redis 연결이 잠깐만 끊겨도 갱신 실패 → stalled |
| **시스템 부하** | CPU/메모리 부족으로 갱신 타이머 지연 |
| **LLM 서버 응답 대기 중 블로킹** | await 중 이벤트 루프 처리 지연 가능 |

**10분 작업에서 특히 위험한 이유:**
```
lockDuration = 30초인데 작업은 10분?

방법 1 (나쁨): lockDuration을 10분으로 설정
  → Worker가 실제로 죽으면 10분 동안 아무도 못 가져감
  → 사용자는 10분 기다려도 응답 없음

방법 2 (좋음): Lock 자동 갱신
  → lockDuration은 30초로 유지
  → 10초마다 Lock 갱신
  → 정상: 10분 동안 Lock 유지
  → 이상: 빠르게 감지하여 다른 Worker에게 넘김
```

---

## 3. 해결 전략 개요

### 3.1 핵심 아이디어: "누가 진짜 주인인가?"

문제의 본질은 **"누가 현재 유효한 Writer인가"**를 알 수 없다는 것입니다.

해결책: **펜싱 토큰 (Fencing Token)**

```
┌─────────────────────────────────────────────────────────────┐
│  개념: 분산 시스템에서 "현재 유효한 주인"을 식별하는 토큰     │
│                                                             │
│  비유: 마이크를 든 사람만 말할 수 있는 회의                  │
│        마이크 = 펜싱 토큰                                   │
│        새로운 사람이 마이크를 받으면 이전 사람은 발언 불가    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 3계층 방어 전략

```
┌─────────────────────────────────────────────────────────────┐
│            1계층: Lock 자동 갱신 + 펜싱 토큰 검증             │
│  ─────────────────────────────────────────────────────────  │
│  "10초마다 Lock 갱신하면서 토큰 유효성도 검증"               │
│  → Lock 갱신으로 stalled 예방                               │
│  → 토큰 검증으로 좀비 여부 감지                              │
│  → 매 발행마다 검증하지 않아 Redis 부하 감소                 │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   2계층: AbortController                     │
│  ─────────────────────────────────────────────────────────  │
│  "토큰이 무효화되었거나 stalled 되면 즉시 종료"              │
│  → 좀비 프로세스가 계속 돌아가지 않도록 빠르게 정리          │
│  → LLM 서버 연결 종료, 리소스 해제                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              3계층: valid-history 필터링                     │
│  ─────────────────────────────────────────────────────────  │
│  "좀비 데이터가 일부 들어가도 조회 시 필터링"                │
│  → 토큰 기반으로 유효한 데이터만 반환                        │
│  → 최대 10초 지연 동안의 오염 데이터 정리                    │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 각 계층의 역할

| 계층 | 역할 | 비유 |
|------|------|------|
| **Lock + 토큰 검증** | 10초마다 좀비 여부 감지 | 10초마다 마이크 소유권 확인 |
| **AbortController** | 좀비 감지 시 즉시 종료 | 마이크 빼앗기면 즉시 조용해짐 |
| **valid-history** | 오염 데이터 필터링 | 녹음에서 잡음 제거 |

---

## 4. 전체 시스템 아키텍처

### 4.1 컴포넌트 구성

```
┌────────────────────────────────────────────────────────────────────────┐
│                              클라이언트                                 │
│                                  │                                     │
│                           POST /research/start                         │
│                           GET  /research/stream/:jobId (SSE)           │
└────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      ResearchController                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ • POST /start: Job을 Queue에 추가                                │   │
│  │ • GET /stream/:jobId: SSE로 실시간 스트리밍                      │   │
│  │ • GET /history/:jobId: 전체 히스토리 (디버깅용)                  │   │
│  │ • GET /valid-history/:jobId: 유효한 데이터만 (필터링됨)          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   Redis Queue    │    │  Redis Stream    │    │  Redis KV Store  │
│  (BullMQ)        │    │  (Pub/Sub)       │    │  (Fencing Token) │
│                  │    │                  │    │                  │
│ • deep-research  │    │ • research:xxx   │    │ • fencing:xxx    │
│   큐에 Job 저장  │    │   실시간 데이터   │    │   토큰 정보 저장  │
└──────────────────┘    └──────────────────┘    └──────────────────┘
          │                        ▲                        │
          │                        │                        │
          ▼                        │                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      ResearchProcessor (Worker)                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 1. Job 시작 시:                                                  │   │
│  │    • AbortController 생성                                        │   │
│  │    • 펜싱 토큰 획득 (이전 토큰 자동 무효화)                       │   │
│  │    • Lock 자동 갱신 타이머 시작 (10초마다)                       │   │
│  │                                                                  │   │
│  │ 2. LLM 서버 통신 중 (약 10분):                                   │   │
│  │    • 딥리서치 LLM 서버에 요청 전송                               │   │
│  │    • LLM 서버에서 진행상황 수신할 때마다:                        │   │
│  │      - checkAborted(): abort 여부 확인                           │   │
│  │      - safePublish(): 펜싱 토큰 검증 후 Stream에 발행            │   │
│  │    • 백그라운드에서 10초마다 Lock 갱신                           │   │
│  │                                                                  │   │
│  │ 3. 완료/에러/Abort 시:                                           │   │
│  │    • LLM 서버 연결 종료                                          │   │
│  │    • cleanupJob(): 타이머 정리, 컨텍스트 삭제                    │   │
│  │    • 펜싱 토큰 해제                                              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         StreamService                                   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ • acquireFencingToken(): 새 토큰 발급 (이전 토큰 덮어씀)         │   │
│  │ • validateFencingToken(): 토큰 유효성 검증                       │   │
│  │ • publish(): Lua Script로 원자적 검증 + 발행                     │   │
│  │ • getValidHistory(): 유효한 데이터만 필터링                      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 데이터 흐름 (10분 LLM 작업)

```
사용자 요청
     │
     ▼
┌─────────────────────┐
│ POST /research/start│
│ { query: "AI 동향" }│
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│ Queue에 Job 추가    │
│ jobId: research-123 │
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│ Worker가 Job 가져감 │
│ → 펜싱 토큰 획득    │
│ → Lock 갱신 시작    │
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│ 딥리서치 LLM 서버에 │
│ 요청 전송           │
└─────────────────────┘
     │
     │  약 10분 동안 진행상황 수신
     ▼
┌─────────────────────┐      ┌─────────────────────┐
│ LLM 응답 수신       │      │ Redis Stream        │
│ (토큰 검증 후 발행) │ ───▶ │ XADD + PUBLISH      │
│                     │      │                     │
│ ※ 10초마다 Lock 갱신│      │                     │
└─────────────────────┘      └─────────────────────┘
     │                              │
     │                              ▼
     │                       ┌─────────────────────┐
     │                       │ SSE로 클라이언트에   │
     │                       │ 실시간 전달          │
     │                       └─────────────────────┘
     ▼
┌─────────────────────┐
│ LLM 작업 완료       │
│ → 토큰 해제         │
│ → 정리 작업         │
└─────────────────────┘
```

---

## 5. 상세 동작 흐름

### 5.1 Job 시작 단계

```typescript
// ResearchProcessor.process()

async process(job: Job<{ query: string; jobId: string }>) {
  const { query, jobId } = job.data;
```

**Step 1: 중복 실행 방지**

```
┌─────────────────────────────────────────────────────────────┐
│ if (this.activeJobs.has(jobId)) {                           │
│   throw new UnrecoverableError('Job already running');      │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘

왜 필요한가?
• BullMQ 버그나 네트워크 이슈로 같은 Job이 두 번 들어올 수 있음
• 같은 Worker 내에서 중복 실행 방지
• Map으로 현재 실행 중인 Job들을 추적
```

**Step 2: AbortController 생성**

```
┌─────────────────────────────────────────────────────────────┐
│ const abortController = new AbortController();              │
│ const { signal } = abortController;                         │
└─────────────────────────────────────────────────────────────┘

구조:
                    ┌─────────────────────┐
                    │  AbortController    │
                    │  ───────────────    │
                    │  • abort()          │ ← 취소 명령
                    │  • signal           │ ← 취소 상태
                    └─────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │    AbortSignal      │
                    │  ───────────────    │
                    │  • aborted: boolean │ ← true면 취소됨
                    │  • onabort: handler │ ← 취소 시 콜백
                    └─────────────────────┘
```

**Step 3: 펜싱 토큰 획득**

```
┌─────────────────────────────────────────────────────────────┐
│ const fencingToken = await this.streamService              │
│   .acquireFencingToken(jobId, this.instanceId);            │
└─────────────────────────────────────────────────────────────┘

Redis에서 일어나는 일:

Key: fencing:research-123

Before (Worker A의 토큰):
┌─────────────────────────────────────────────────────────────┐
│ { token: "abc123", workerId: "worker-A", createdAt: ... }   │
└─────────────────────────────────────────────────────────────┘

After (Worker B가 토큰 획득):
┌─────────────────────────────────────────────────────────────┐
│ { token: "xyz789", workerId: "worker-B", createdAt: ... }   │
└─────────────────────────────────────────────────────────────┘

핵심: SET 명령은 기존 값을 덮어씀
→ Worker A의 토큰 "abc123"은 자동으로 무효화됨
→ 별도의 "이전 토큰 삭제" 로직 불필요
```

**Step 4: JobContext 초기화**

```
┌─────────────────────────────────────────────────────────────┐
│ const context: JobContext = {                               │
│   abortController,      // 이 Job만 취소 가능               │
│   fencingToken,         // 이 Job의 유효성 증명             │
│   lockExtendInterval,   // Lock 갱신 타이머                 │
│   isAborted: false,     // 중복 abort 방지 플래그           │
│ };                                                          │
│                                                             │
│ this.activeJobs.set(jobId, context);                        │
└─────────────────────────────────────────────────────────────┘

왜 Map으로 관리하나?

Worker가 동시에 여러 Job을 처리할 수 있음 (concurrency > 1)
각 Job마다 독립적인 context가 필요

activeJobs Map:
┌─────────────────────────────────────────────────────────────┐
│ "research-123" → { abortController: ..., token: "abc" }     │
│ "research-456" → { abortController: ..., token: "xyz" }     │
│ "research-789" → { abortController: ..., token: "qwe" }     │
└─────────────────────────────────────────────────────────────┘

Job-123이 stalled 되면?
→ "research-123"의 abortController만 abort()
→ 다른 Job들은 영향 없음
```

**Step 5: Lock 자동 갱신 시작**

```
┌─────────────────────────────────────────────────────────────┐
│ context.lockExtendInterval =                                │
│   this.startLockExtension(job, jobId, signal);              │
└─────────────────────────────────────────────────────────────┘

시간 흐름:

lockDuration = 30초
갱신 주기 = 10초

시간: 0초 ─── 10초 ─── 20초 ─── 30초 ─── 40초 ─── 50초
             │        │        │        │        │
Lock:   [──────────────────────────]
             ↓        ↓        ↓
          갱신!    갱신!    갱신!
        [────────────────────────────────────]
                       [────────────────────────────────────]
                                  [────────────────────────────...]

→ 정상적인 경우 Lock은 절대 만료되지 않음
→ 갱신 실패 시 즉시 abortJob() 호출
```

### 5.2 Step 실행 단계

```typescript
// ResearchProcessor.executeResearch()

for (let i = 0; i < steps.length; i++) {
```

**LLM 서버 호출 시 핵심: signal 전달**

```typescript
// fetch에 signal을 전달하면 abort() 시 요청이 취소됨
const response = await fetch(LLM_SERVER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, jobId }),
  signal,  // ← 이게 핵심! abort() 호출 시 연결 끊김
});
```

**LLM 응답 처리 흐름:**

```
┌─────────────────────────────────────────────────────────────┐
│                   LLM SSE 스트림 처리                        │
└─────────────────────────────────────────────────────────────┘

const reader = response.body.getReader();

while (true) {
    ┌─────────────────────┐
    │ 1. checkAborted()   │
    │    abort 여부 확인  │
    └─────────────────────┘
              │
              ▼ (abort 안 됐으면)
    ┌─────────────────────┐
    │ 2. reader.read()    │
    │    LLM 응답 수신    │
    └─────────────────────┘
              │
              ▼
    ┌─────────────────────┐
    │ 3. publish()        │
    │    검증 없이 발행   │
    └─────────────────────┘
              │
              ▼
         다음 chunk
}
```

**abort() 호출 시 일어나는 일:**

```
┌─────────────────────────────────────────────────────────────┐
│ abortJob() 호출                                              │
│     │                                                       │
│     ▼                                                       │
│ context.isAborted = true                                    │
│ context.abortController.abort()                             │
│     │                                                       │
│     ├──▶ fetch 요청 취소 (signal이 연결됨)                   │
│     │    → LLM 서버와의 연결 즉시 끊김                       │
│     │                                                       │
│     ├──▶ reader.read() 에서 에러 발생                       │
│     │    → catch 블록으로 이동                               │
│     │                                                       │
│     └──▶ interruptibleDelay() 즉시 reject                   │
│          → 대기 중이던 작업 취소                             │
└─────────────────────────────────────────────────────────────┘
```

**백그라운드: 10초마다 실행**

```typescript
setInterval(async () => {
  // 1. Lock 갱신
  await job.extendLock(job.token!, 30000);

  // 2. 토큰 검증 (10초마다만 수행)
  const isValid = await this.streamService.validateFencingToken(
    jobId, context.fencingToken
  );

  if (!isValid) {
    this.abortJob(jobId, 'Fencing token invalidated');
    // → fetch 요청 취소됨
    // → LLM 서버 연결 끊김
    // → 좀비 프로세스 종료
  }
}, 10000);
```

**왜 매번 검증하지 않나?**

```
매번 검증 시:
  LLM 응답 100개 → Redis 호출 100회 (Lua Script)
  → Redis 부하 높음

10초마다 검증 시:
  10분 작업 → Redis 호출 60회 (단순 GET)
  → Redis 부하 낮음

트레이드오프:
  좀비 감지가 최대 10초 지연될 수 있음
  → 그 사이 좀비 데이터 몇 개 들어갈 수 있음
  → valid-history API에서 필터링됨
```

### 5.3 완료/에러 처리 단계

```
┌─────────────────────────────────────────────────────────────┐
│                     try/catch/finally 구조                   │
└─────────────────────────────────────────────────────────────┘

try {
    // 작업 수행

    // 성공 시:
    await safePublish(jobId, context, { status: 'completed' });
    await releaseFencingToken(jobId, fencingToken);
    return result;

} catch (error) {

    if (signal.aborted || context.isAborted) {
        // 좀비 프로세스 종료
        throw new UnrecoverableError('zombie terminated');
    }

    // 실제 에러
    await safePublish(jobId, context, { status: 'error' });
    throw error;

} finally {
    // 항상 실행 (성공/실패/abort 모두)
    this.cleanupJob(jobId);
}
```

**cleanupJob()의 역할:**

```
┌─────────────────────────────────────────────────────────────┐
│ cleanupJob(jobId):                                          │
│                                                             │
│ 1. Lock 갱신 타이머 정리                                    │
│    if (context.lockExtendInterval) {                        │
│      clearInterval(context.lockExtendInterval);             │
│    }                                                        │
│                                                             │
│ 2. activeJobs Map에서 제거                                   │
│    this.activeJobs.delete(jobId);                           │
│                                                             │
│ → 메모리 누수 방지                                          │
│ → 다음에 같은 Job이 들어와도 정상 처리 가능                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 핵심 코드 분석

### 6.1 파일별 역할

| 파일 | 역할 | 주요 기능 |
|------|------|-----------|
| `research.controller.ts` | HTTP API | Job 시작, SSE 스트리밍, 히스토리 조회 |
| `research.processor.ts` | Job 처리 | LLM 서버 호출, AbortController, Lock 갱신 |
| `stream.service.ts` | Redis 통신 | 토큰 관리, 발행, 히스토리 필터링 |
| `stalled-worker.ts` | 백업 Worker | Stalled Job 처리 (메인 Worker와 동일 로직) |

### 6.2 LLM 서버 호출 코드

```typescript
/**
 * 실제 LLM 서버 호출 (SSE 스트림)
 */
private async callLLMServer(
  job: Job,
  jobId: string,
  query: string,
  context: JobContext,
  signal: AbortSignal
): Promise<{ summary: string }> {

  // fetch에 signal 전달 → abort() 시 요청 취소됨
  const response = await fetch(this.LLM_SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, jobId }),
    signal,  // ← 핵심!
  });

  const reader = response.body.getReader();

  try {
    while (true) {
      // abort 체크
      this.checkAborted(signal, context);

      const { done, value } = await reader.read();
      if (done) break;

      // SSE 파싱
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

      for (const line of lines) {
        const data = JSON.parse(line.slice(6));

        // 진행 상황 발행 (검증 없이)
        if (!context.isAborted) {
          await this.streamService.publish(jobId, {
            status: 'progress',
            percent: data.percent,
            message: data.message,
          }, context.fencingToken);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { summary };
}
```

**환경변수 설정:**

```bash
# .env
LLM_SERVER_URL=https://your-llm-server.com/research

# 환경변수 없으면 시뮬레이션 모드로 동작
```

### 6.2 Processor 설정값 분석

```typescript
@Processor('deep-research', {
  lockDuration: 30000,      // 30초
  stalledInterval: 15000,   // 15초
  maxStalledCount: 1,       // 1회
  concurrency: 1,           // 1개
})
```

**각 설정의 의미:**

```
lockDuration: 30000 (30초)
─────────────────────────────────────────
• Worker가 Job을 "소유"하는 시간
• 이 시간 안에 완료하거나 Lock을 갱신해야 함
• 너무 짧으면: 정상 작업도 stalled 처리될 수 있음
• 너무 길면: 실제로 죽은 Worker의 Job을 오래 기다림

권장: 예상 Step 시간 × 1.5 ~ 2배


stalledInterval: 15000 (15초)
─────────────────────────────────────────
• "이 Job 살아있나?" 확인하는 주기
• lockDuration보다 짧아야 의미 있음
• 너무 짧으면: 불필요한 체크로 Redis 부하
• 너무 길면: 죽은 Job 감지가 느림

권장: lockDuration / 2


maxStalledCount: 1
─────────────────────────────────────────
• stalled로 판정되면 재시도 횟수
• 1 = 한 번 stalled 되면 바로 다른 Worker에게
• 높은 값 = 같은 Worker가 여러 번 시도

권장: 펜싱 토큰 사용 시 1로 설정


concurrency: 1
─────────────────────────────────────────
• 이 Worker 인스턴스가 동시 처리할 Job 수
• 높은 값 = 더 많은 Job 동시 처리
• 리소스 상황에 따라 조정

권장: CPU 코어 수 고려
```

### 6.3 UnrecoverableError의 의미

```typescript
throw new UnrecoverableError('Job was aborted');
```

**일반 Error vs UnrecoverableError:**

```
일반 Error:
┌─────────────────────────────────────────────────────────────┐
│ throw new Error('Something went wrong');                    │
│                                                             │
│ → Job 상태: failed                                          │
│ → 재시도: attempts 설정에 따라 재시도                        │
│   (예: attempts: 3이면 최대 3번 재시도)                     │
└─────────────────────────────────────────────────────────────┘

UnrecoverableError:
┌─────────────────────────────────────────────────────────────┐
│ throw new UnrecoverableError('Job was aborted');            │
│                                                             │
│ → Job 상태: failed (즉시 확정)                              │
│ → 재시도: 없음! 바로 실패 처리                               │
│                                                             │
│ 사용 시나리오:                                               │
│ • 좀비 프로세스 종료                                        │
│ • 펜싱 토큰 무효화                                          │
│ • 복구 불가능한 상황                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. 시나리오별 동작 설명

### 7.1 시나리오 A: 정상 처리 (10분 LLM 작업)

```
시간 → (약 10분)
─────────────────────────────────────────────────────────────────────

클라이언트:
  POST /research/start { query: "AI 동향" }
  ↓
  응답: { jobId: "research-123", streamUrl: "/stream/research-123" }
  ↓
  GET /research/stream/research-123 (SSE 연결)

Worker A:
  ┌─────────────────────────────────────────────────────────────┐
  │ Job 가져옴                                                   │
  │ ↓                                                           │
  │ 펜싱 토큰 획득: "token-aaa"                                  │
  │ Lock 갱신 타이머 시작 (10초마다)                             │
  │ ↓                                                           │
  │ 딥리서치 LLM 서버에 요청 전송                                │
  │ ↓                                                           │
  │ [LLM 서버에서 진행상황 수신 대기...]                         │
  │     ↓                                                       │
  │     progress 10%: safePublish() → 성공 ✓                    │
  │         [10초 경과] Lock 갱신 ✓                              │
  │     progress 25%: safePublish() → 성공 ✓                    │
  │         [20초 경과] Lock 갱신 ✓                              │
  │     progress 50%: safePublish() → 성공 ✓                    │
  │         ... (10분 동안 계속 Lock 갱신) ...                   │
  │     progress 75%: safePublish() → 성공 ✓                    │
  │     progress 90%: safePublish() → 성공 ✓                    │
  │ ↓                                                           │
  │ LLM 서버 작업 완료                                           │
  │ 완료 메시지 발행                                             │
  │ 펜싱 토큰 해제                                               │
  │ cleanupJob()                                                 │
  └─────────────────────────────────────────────────────────────┘

클라이언트가 받은 SSE 메시지:
  data: {"status":"started","workerId":"A","fencingToken":"token-aa"}
  data: {"status":"progress","percent":10,"message":"문서 수집 중..."}
  data: {"status":"progress","percent":25,"message":"1차 분석 중..."}
  data: {"status":"progress","percent":50,"message":"심층 분석 중..."}
  data: {"status":"progress","percent":75,"message":"결과 종합 중..."}
  data: {"status":"progress","percent":90,"message":"보고서 작성 중..."}
  data: {"status":"completed","result":"Research completed"}

결과: 10분 동안 완벽하게 순차적인 데이터 ✓
```

### 7.2 시나리오 B: 10분 작업 중 Stalled 발생 + 좀비 프로세스 차단

```
시간 → (약 10분)
─────────────────────────────────────────────────────────────────────

Worker A (메인 서버):
  ┌─────────────────────────────────────────────────────────────┐
  │ Job 가져옴                                                   │
  │ 펜싱 토큰 획득: "token-aaa"                                  │
  │ Lock 갱신 타이머 시작                                        │
  │ ↓                                                           │
  │ 딥리서치 LLM 서버에 요청 전송                                │
  │ ↓                                                           │
  │ [LLM 서버에서 진행상황 수신 중...]                           │
  │     progress 10%: safePublish() → 성공 ✓                    │
  │     progress 25%: safePublish() → 성공 ✓                    │
  │ ↓                                                           │
  │ [Redis 연결 일시적 끊김!]                                    │
  │ [Lock 갱신 실패...]                                          │
  │ [stalledInterval 경과...]                                    │
  │                                                             │
  │ ※ 하지만 LLM 서버는 계속 작업 중!                           │
  │ ※ Worker A는 LLM 응답을 계속 받고 있음!                     │
  │                                                             │
  └─── BullMQ: "Worker A stalled!" ──────────────────────────────┘
                    │
                    ▼
Worker B (Stalled Worker):
  ┌─────────────────────────────────────────────────────────────┐
  │ Stalled Job 가져옴                                          │
  │ ↓                                                           │
  │ 펜싱 토큰 획득: "token-bbb"   ← "token-aaa" 덮어씀!         │
  │ Lock 갱신 타이머 시작                                        │
  │ ↓                                                           │
  │ 딥리서치 LLM 서버에 새로 요청 전송                           │
  │ ↓                                                           │
  │ [LLM 서버에서 진행상황 수신 중...]                           │
  │     progress 10%: safePublish() → 성공 ✓                    │
  │ ...                                                         │
  └─────────────────────────────────────────────────────────────┘

Worker A (좀비 - LLM 응답 계속 받는 중):
  ┌─────────────────────────────────────────────────────────────┐
  │ [Redis 연결 복구됨]                                          │
  │ [LLM 서버에서 progress 50% 수신]                             │
  │ ↓                                                           │
  │ progress 50% 발행 시도: safePublish("token-aaa")            │
  │ ↓                                                           │
  │ Redis Lua Script:                                           │
  │   현재 토큰: "token-bbb"                                    │
  │   요청 토큰: "token-aaa"                                    │
  │   "token-aaa" ≠ "token-bbb" → return 0 (차단!)              │
  │ ↓                                                           │
  │ safePublish() returns false                                 │
  │ context.isAborted = true                                    │
  │ ↓                                                           │
  │ LLM 서버 연결 종료 (abort signal)                           │
  │ throw UnrecoverableError('Fencing token invalidated')       │
  │ ↓                                                           │
  │ finally: cleanupJob()                                       │
  │ ↓                                                           │
  │ 좀비 프로세스 정상 종료 ✓                                    │
  │ (LLM 서버의 나머지 응답은 무시됨)                            │
  └─────────────────────────────────────────────────────────────┘

Worker B (10분 작업 계속):
  ┌─────────────────────────────────────────────────────────────┐
  │     progress 25%: safePublish() → 성공 ✓                    │
  │     progress 50%: safePublish() → 성공 ✓                    │
  │     ... (나머지 10분 작업) ...                               │
  │     progress 75%: safePublish() → 성공 ✓                    │
  │     progress 90%: safePublish() → 성공 ✓                    │
  │ 완료! ✓                                                      │
  └─────────────────────────────────────────────────────────────┘

Redis Stream (실제 저장된 데이터):
  ▸ started (A, token-aaa)
  ▸ progress 10% (A, token-aaa)
  ▸ progress 25% (A, token-aaa)
  ▸ started (B, token-bbb)      ← Worker B 시작
  ▸ progress 10% (B, token-bbb)
  ← Worker A의 50%, 75%, 90%, completed는 차단됨! 저장 안 됨!
  ▸ progress 25% (B, token-bbb)
  ▸ progress 50% (B, token-bbb)
  ▸ progress 75% (B, token-bbb)
  ▸ progress 90% (B, token-bbb)
  ▸ completed (B, token-bbb)

/valid-history API 결과 (필터링 적용):
  ▸ started (B, token-bbb)
  ▸ progress 10% (B, token-bbb)
  ▸ progress 25% (B, token-bbb)
  ▸ progress 50% (B, token-bbb)
  ▸ progress 75% (B, token-bbb)
  ▸ progress 90% (B, token-bbb)
  ▸ completed (B, token-bbb)

→ Worker A의 오염된 데이터는 모두 필터링됨 ✓
→ 10분 작업이어도 안전하게 처리됨 ✓
```

### 7.3 시나리오 C: SSE 클라이언트의 실시간 처리

```
클라이언트가 SSE로 연결한 상태에서 Worker 교체가 일어나면?

ResearchController.streamResults():
┌─────────────────────────────────────────────────────────────┐
│ let currentFencingToken: string | null = null;              │
│                                                             │
│ this.streamService.subscribe(jobId, (data) => {             │
│   if (data.fencingToken !== 'none') {                       │
│                                                             │
│     if (!currentFencingToken) {                             │
│       // 첫 번째 데이터 → 토큰 기억                          │
│       currentFencingToken = data.fencingToken;              │
│                                                             │
│     } else if (data.fencingToken !== currentFencingToken) { │
│       // 토큰 변경됨 → 새 Worker가 인계받음                  │
│       currentFencingToken = data.fencingToken;              │
│                                                             │
│       // 클라이언트에게 "리셋" 알림                          │
│       subscriber.next({                                     │
│         data: JSON.stringify({                              │
│           status: 'reset',                                  │
│           message: 'New worker took over'                   │
│         })                                                  │
│       });                                                   │
│     }                                                       │
│   }                                                         │
│                                                             │
│   subscriber.next({ data: JSON.stringify(data) });          │
│ });                                                         │
└─────────────────────────────────────────────────────────────┘

클라이언트가 받는 메시지:
  data: {"status":"started","fencingToken":"token-aa"}
  data: {"status":"progress","step":1}
  data: {"status":"progress","step":2}
  data: {"status":"reset","message":"New worker took over"}  ← 리셋 알림!
  data: {"status":"started","fencingToken":"token-bb"}
  data: {"status":"progress","step":1}
  data: {"status":"progress","step":2}
  ...
  data: {"status":"completed"}

→ 클라이언트는 "reset" 메시지를 받으면 UI를 초기화할 수 있음
```

---

## 8. 테스트 및 검증

### 8.1 테스트 환경 설정

```bash
# 터미널 1: Redis 실행
docker run -d -p 6379:6379 redis

# 터미널 2: 메인 서버 시작
cd bullmq-race-condition
npm run start:dev

# 터미널 3: Stalled Worker 시작 (선택)
npx ts-node src/stalled-worker.ts
```

### 8.2 정상 동작 테스트

```bash
# 1. 작업 시작
curl -X POST http://localhost:3000/research/start \
  -H "Content-Type: application/json" \
  -d '{"query": "AI 기술 동향"}'

# 응답 예시:
# {
#   "jobId": "research-1699876543210",
#   "streamUrl": "/research/stream/research-1699876543210"
# }

# 2. 실시간 스트리밍 구독
curl http://localhost:3000/research/stream/research-1699876543210

# 3. 히스토리 확인
curl http://localhost:3000/research/valid-history/research-1699876543210
```

### 8.3 Race Condition 시뮬레이션

**방법 1: 메인 서버 일시 정지**

```bash
# 터미널 1: 메인 서버 실행 중
# 터미널 2: Stalled Worker 실행 중
# 터미널 3: 작업 시작 후...

# 메인 서버 일시 정지 (Ctrl+Z)
# → Lock 갱신 중단
# → stalledInterval 후 Job이 Stalled Worker로 넘어감

# 메인 서버 재개 (fg)
# → 좀비 프로세스가 발행 시도
# → 펜싱 토큰 불일치로 차단됨

# 로그에서 확인:
# 🚫 [worker-abc] BLOCKED: Invalid fencing token - zombie process detected
```

**방법 2: Lock 설정 조정**

```typescript
// research.processor.ts
@Processor('deep-research', {
  lockDuration: 5000,      // 5초로 줄임 (테스트용)
  stalledInterval: 3000,   // 3초
  // ...
})
```

### 8.4 검증 체크리스트

| 항목 | 확인 방법 | 기대 결과 |
|------|-----------|-----------|
| 정상 처리 | `/valid-history` 확인 | 순차적인 Step 1→2→3→4→5 |
| 좀비 차단 | 로그에서 `BLOCKED` 확인 | 무효한 토큰 발행 시도 차단 |
| 데이터 정합성 | `/history` vs `/valid-history` | valid-history가 깔끔함 |
| SSE 리셋 | 클라이언트에서 확인 | `reset` 메시지 수신 |
| 리소스 정리 | 메모리 모니터링 | 메모리 누수 없음 |

---

## 부록: 권장 설정값 (10분 LLM 작업 기준)

| 설정 | 권장값 | 계산 근거 |
|------|--------|-----------|
| `lockDuration` | 30000ms (30초) | Lock 갱신으로 유지하므로 길 필요 없음 |
| `stalledInterval` | 15000ms (15초) | lockDuration / 2 |
| `maxStalledCount` | 1 | 빠른 재할당 (펜싱 토큰이 처리) |
| Lock 갱신 주기 | 10000ms (10초) | lockDuration / 3 |
| 펜싱 토큰 TTL | 3600초 (1시간) | 10분 작업 + 여유 |

**10분 장기 작업에서 핵심:**
- `lockDuration`을 10분으로 설정하지 않음!
- 대신 **Lock 자동 갱신**으로 10분 동안 유지
- 갱신 실패 시 빠르게 감지하여 다른 Worker에게 넘김

---

## 요약: 핵심 포인트

1. **문제**: 10분 LLM 작업 중 Lock 만료 시, 두 Worker가 동시에 LLM 서버 응답을 받아 Stream에 발행 → 데이터 오염

2. **해결책**: 3계층 방어
   - **Lock + 토큰 검증 (10초마다)**: 좀비 여부 감지, Redis 부하 최소화
   - **AbortController**: 좀비 감지 시 LLM 연결 종료, 빠른 정리
   - **valid-history 필터링**: 최대 10초 지연 동안의 오염 데이터 정리

3. **핵심 흐름**:
   - 새 Worker → 새 토큰 획득 → 이전 토큰 무효화
   - 발행은 검증 없이 진행 (Redis 부하 감소)
   - 10초마다 토큰 검증 → 불일치면 abort
   - 조회 시 valid-history로 오염 데이터 필터링

4. **결과**: 10분 장기 작업에서도 클라이언트는 항상 깔끔한 순차 데이터만 수신
