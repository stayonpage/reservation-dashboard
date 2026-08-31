# 오마이북 프로모션 자동 비고 기입 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스테이폴리오 프로모션 대상 예약이 수신되면 `reservations.notes` 뒤에 `오마이북 3만원 상품권 증정` 문구를 자동으로 이어붙인다.

**Architecture:** 순수 판정 모듈(`lib/promo.ts`) + 수신 관문(`lib/ingest.ts`)에서 `ingest_reservation` 성공 직후 best-effort로 `notes` 갱신. DB 마이그레이션 없음, `ingest_reservation` 시그니처 불변.

**Tech Stack:** TypeScript, Next.js 15.3, Supabase JS, Vitest, mailparser(`simpleParser`), imapflow.

## Global Constraints

- 채널은 **스테이폴리오만** 대상.
- 문구는 정확히 `오마이북 3만원 상품권 증정` — 두 프로모션 공통, 한 예약에 한 번만.
- **직원추천**: 확정메일(KST) 9/1~9/30, 체크인 ≤ 2026-11-30, 전 객실. 체크인이 토요일이거나 공휴일 바로 전날이면 제외.
- **웰니스**: 확정메일(KST) 9/14~10/18, 체크인 ≤ 2026-11-30, 객실 코드가 `page26` 또는 `page452`. 요일·공휴일 제한 없음.
- 2026년 9~11월 공휴일(대체공휴일 포함): `2026-09-24, 2026-09-25, 2026-09-26, 2026-09-28, 2026-10-03, 2026-10-05, 2026-10-09`. 11월 없음.
- "확정메일 도착 시각" = 메일 `Date` 헤더(`parsedMail.date`).
- 판정 실패/비고 갱신 실패가 예약 수신(`IngestResult`)을 실패시키면 안 된다 — 에러는 `console.error` 후 삼킨다.
- 게이트: `npx tsc --noEmit` 0, `TZ=UTC npx vitest run` 전부 통과, `npm run build` 성공.

---

### Task 1: `lib/promo.ts` — 순수 판정 + 비고 이어붙이기

**Files:**
- Create: `lib/promo.ts`
- Test: `lib/promo.test.ts`

**Interfaces:**
- Consumes: `roomCodeOf(roomName: string | null): string | null` from `lib/rooms.ts` (기존).
- Produces:
  - `OMAIBOOK_PROMO_NOTE: string` (`'오마이북 3만원 상품권 증정'`)
  - `PROMO_HOLIDAYS_2026: Set<string>`
  - `omaibookPromoEligible(input: { channel: string; roomName: string | null; checkIn: string; cancelled: boolean; confirmedMailAt: Date }): boolean`
  - `appendPromoNote(existing: string | null): string | null`

- [ ] **Step 1: Write the failing test**

Create `lib/promo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  omaibookPromoEligible,
  appendPromoNote,
  OMAIBOOK_PROMO_NOTE,
} from './promo';

// 기본: 스테이폴리오, 확정메일 KST 2026-09-10, page8, 체크인 2026-11-10(화) — 직원추천 대상.
const base = {
  channel: 'stayfolio',
  roomName: 'page8 - 어떤 책',
  checkIn: '2026-11-10',
  cancelled: false,
  confirmedMailAt: new Date('2026-09-10T02:00:00Z'), // +9h → 2026-09-10
};
const run = (over: Partial<typeof base> = {}) =>
  omaibookPromoEligible({ ...base, ...over });

describe('omaibookPromoEligible — 직원추천', () => {
  it('9월 확정 + 평일 체크인 + 전 객실 → true', () => {
    expect(run()).toBe(true);
  });
  it('체크인 토요일(2026-11-07) → false', () => {
    expect(run({ checkIn: '2026-11-07' })).toBe(false);
  });
  it('체크인이 한글날(10/9) 전날 2026-10-08 → false', () => {
    expect(run({ checkIn: '2026-10-08' })).toBe(false);
  });
  it('체크인이 대체공휴일(9/28) 전날 2026-09-27 → false', () => {
    expect(run({ checkIn: '2026-09-27' })).toBe(false);
  });
  it('확정메일 KST 2026-08-31 → false (기간 전)', () => {
    expect(run({ confirmedMailAt: new Date('2026-08-31T03:00:00Z') })).toBe(false);
  });
  it('확정메일 KST 2026-10-01 + page8 → false (9월 지남, 웰니스 객실 아님)', () => {
    expect(run({ confirmedMailAt: new Date('2026-10-01T03:00:00Z') })).toBe(false);
  });
});

describe('omaibookPromoEligible — 웰니스', () => {
  it('KST 9/20 확정 + page26 + 체크인 토요일 → true (요일 무관)', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-09-20T03:00:00Z'),
        roomName: 'page26 - 시가 내려앉는 순간',
        checkIn: '2026-11-07',
      }),
    ).toBe(true);
  });
  it('KST 10/10 확정 + page8 → false (대상 객실 아님)', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-10-10T03:00:00Z'),
        roomName: 'page8 - x',
      }),
    ).toBe(false);
  });
  it('KST 10/19 확정 + page452 → false (기간 지남)', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-10-19T03:00:00Z'),
        roomName: 'page452 - y',
      }),
    ).toBe(false);
  });
});

describe('omaibookPromoEligible — 공통', () => {
  it('겹침 기간: KST 9/20 확정 + page452 + 평일 체크인 → true', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-09-20T03:00:00Z'),
        roomName: 'page452 - y',
      }),
    ).toBe(true);
  });
  it('체크인 2026-12-01 → false (11월까지 아님)', () => {
    expect(run({ checkIn: '2026-12-01' })).toBe(false);
  });
  it('channel=naver → false', () => {
    expect(run({ channel: 'naver' })).toBe(false);
  });
  it('cancelled=true → false', () => {
    expect(run({ cancelled: true })).toBe(false);
  });
});

describe('appendPromoNote', () => {
  it('null → 문구', () => {
    expect(appendPromoNote(null)).toBe(OMAIBOOK_PROMO_NOTE);
  });
  it('빈 문자열 → 문구', () => {
    expect(appendPromoNote('')).toBe(OMAIBOOK_PROMO_NOTE);
  });
  it('기존 메모 → 개행 후 이어붙임', () => {
    expect(appendPromoNote('직원 메모')).toBe(`직원 메모\n${OMAIBOOK_PROMO_NOTE}`);
  });
  it('이미 문구 포함 → null', () => {
    expect(appendPromoNote(`손님 주의\n${OMAIBOOK_PROMO_NOTE}`)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC npx vitest run lib/promo.test.ts`
Expected: FAIL — `Failed to resolve import "./promo"` / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/promo.ts`:

```ts
import { roomCodeOf } from './rooms';

export const OMAIBOOK_PROMO_NOTE = '오마이북 3만원 상품권 증정';

/**
 * 2026년 9~11월 한국 공휴일 (대체공휴일 포함). 프로모션 범위 밖 날짜는 불필요.
 * 추석 연휴 9/24(목)·9/25(금)·9/26(토) + 대체 9/28(월),
 * 개천절 10/3(토) + 대체 10/5(월), 한글날 10/9(금). 11월 공휴일 없음.
 */
export const PROMO_HOLIDAYS_2026 = new Set([
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
  '2026-09-28',
  '2026-10-03',
  '2026-10-05',
  '2026-10-09',
]);

/** Date → 한국시간 기준 'YYYY-MM-DD'. */
function kstDateString(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 다음날 'YYYY-MM-DD'. */
function nextDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 가 토요일인가. */
function isSaturday(iso: string): boolean {
  return new Date(iso + 'T00:00:00Z').getUTCDay() === 6;
}

/**
 * 오마이북 3만원 상품권 프로모션 대상인가.
 * 직원추천(확정 9/1~9/30, 전 객실, 토·공휴일 전날 체크인 제외) 또는
 * 웰니스(확정 9/14~10/18, page26·452, 요일 제한 없음) 중 하나라도 충족하면 true.
 * 두 프로모션 문구가 같아 어느 쪽인지는 구분하지 않는다.
 */
export function omaibookPromoEligible(input: {
  channel: string;
  roomName: string | null;
  checkIn: string; // 'YYYY-MM-DD'
  cancelled: boolean;
  confirmedMailAt: Date; // 스테이폴리오 확정메일 Date 헤더
}): boolean {
  const { channel, roomName, checkIn, cancelled, confirmedMailAt } = input;
  if (channel !== 'stayfolio' || cancelled) return false;
  if (checkIn > '2026-11-30') return false; // 11월까지 투숙

  const applyDate = kstDateString(confirmedMailAt);

  // 웰니스: 확정일 9/14~10/18 + 객실 page26·452
  if (applyDate >= '2026-09-14' && applyDate <= '2026-10-18') {
    const code = roomCodeOf(roomName);
    if (code === 'page26' || code === 'page452') return true;
  }

  // 직원추천: 확정일 9/1~9/30 + 체크인 토요일 아님 + 다음날 공휴일 아님
  if (applyDate >= '2026-09-01' && applyDate <= '2026-09-30') {
    if (!isSaturday(checkIn) && !PROMO_HOLIDAYS_2026.has(nextDay(checkIn))) {
      return true;
    }
  }

  return false;
}

/**
 * 비고(notes)에 프로모션 문구를 이어붙인 새 값. 변경 불필요면 null.
 * - 이미 문구 포함 → null
 * - 비어있음 → 문구만
 * - 그 외 → 기존값 + 개행 + 문구
 */
export function appendPromoNote(existing: string | null): string | null {
  if (existing && existing.includes(OMAIBOOK_PROMO_NOTE)) return null;
  if (!existing) return OMAIBOOK_PROMO_NOTE;
  return `${existing}\n${OMAIBOOK_PROMO_NOTE}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TZ=UTC npx vitest run lib/promo.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/promo.ts lib/promo.test.ts
git commit -m "feat: 오마이북 프로모션 대상 판정 + 비고 이어붙이기 (lib/promo)"
```

---

### Task 2: 수신 파이프라인 배선

**Files:**
- Modify: `lib/ingest.ts` (`handleIncoming` 인자에 `receivedAt?: Date`, `ingest_reservation` 성공 직후 프로모션 비고 갱신)
- Modify: `lib/mail/poll-gmail.ts` (`handleIncoming` 호출에 `receivedAt: parsedMail.date`)

**Interfaces:**
- Consumes: `omaibookPromoEligible`, `appendPromoNote` from `lib/promo.ts` (Task 1).
- Produces: 없음 (파이프라인 부수효과만).

- [ ] **Step 1: `lib/ingest.ts` — import 추가**

파일 상단 import 블록에 추가:

```ts
import { omaibookPromoEligible, appendPromoNote } from './promo';
```

- [ ] **Step 2: `lib/ingest.ts` — `handleIncoming` 인자 타입 + 구조분해에 `receivedAt` 추가**

`handleIncoming` 의 인자 타입에 한 줄 추가:

```ts
export async function handleIncoming(args: {
  source: IngestSource;
  externalId: string; // 메일 UID / SMS id / webhook id — 원시 멱등 키
  raw: string;
  // 비동기 허용: 스테이폴리오는 파싱 후 ICS 피드를 조회해 진짜 예약번호로 보강한다
  // (stayfolio-rooms.ts + stayfolio-ics.ts 참고) — 이메일 자체엔 예약번호가 없음.
  parse: (raw: string) => ParsedReservation | null | Promise<ParsedReservation | null>;
  // 스테이폴리오 확정메일 Date 헤더 — 프로모션 신청 기간 판정에 쓴다. 없으면 현재 시각.
  receivedAt?: Date;
}): Promise<IngestResult> {
  const { source, externalId, raw, parse, receivedAt } = args;
```

(기존 구조분해 줄 `const { source, externalId, raw, parse } = args;` 를 위처럼 `receivedAt` 포함으로 교체.)

- [ ] **Step 3: `lib/ingest.ts` — 프로모션 비고 갱신 블록 삽입**

`await markLog({ status: 'parsed', parsed_reservation_id: data });` 다음 줄, `return { status: 'parsed', reservationId: data as string };` 앞에 삽입:

```ts
  // 오마이북 3만원 상품권 프로모션 — 대상이면 비고에 안내 문구를 남긴다(best-effort:
  // 실패해도 예약 수신 자체는 성공으로 둔다).
  try {
    if (
      omaibookPromoEligible({
        channel: parsed.channel,
        roomName: parsed.room_name,
        checkIn: parsed.check_in,
        cancelled: parsed.cancelled,
        confirmedMailAt: receivedAt ?? new Date(),
      })
    ) {
      const { data: row } = await supabase
        .from('reservations')
        .select('notes')
        .eq('id', data as string)
        .single();
      const nextNotes = appendPromoNote(row?.notes ?? null);
      if (nextNotes !== null) {
        const { error: noteErr } = await supabase
          .from('reservations')
          .update({ notes: nextNotes })
          .eq('id', data as string);
        if (noteErr) console.error('[promo-note]', data, noteErr.message);
      }
    }
  } catch (e) {
    console.error('[promo-note]', data, e instanceof Error ? e.message : String(e));
  }
```

- [ ] **Step 4: `lib/mail/poll-gmail.ts` — `receivedAt` 전달**

`handleIncoming` 호출을 찾아(`source: 'stayfolio_email'`) `receivedAt` 한 줄 추가:

```ts
        const outcome = await handleIncoming({
          source: 'stayfolio_email',
          externalId,
          raw: text,
          parse: parseStayfolioEmailWithRealId,
          receivedAt: parsedMail.date,
        });
```

- [ ] **Step 5: 게이트 — 타입체크**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: 게이트 — 전체 테스트**

Run: `TZ=UTC npx vitest run`
Expected: PASS — 기존 135 + Task 1 의 17 = 152 tests. (`lib/mail/poll-gmail.test.ts` 포함 전부 통과.)

- [ ] **Step 7: 게이트 — 빌드**

Run: `npm run build`
Expected: 성공 (exit 0).

- [ ] **Step 8: Commit**

```bash
git add lib/ingest.ts lib/mail/poll-gmail.ts
git commit -m "feat: 스테이폴리오 수신 시 프로모션 비고 자동 기입 배선"
```

---

## 완료 후

- PR 생성(base `main`), 본문에 배포 순서: **코드만 — DB 마이그레이션 없음.** 머지 → Vercel 자동 배포. 9/1 전 배포 확인.
- 배포 후 확인: 다음 스테이폴리오 확정메일이 들어왔을 때(9/1 이후) 대상이면 대시보드 예약 카드 비고에 문구가 뜨는지.
