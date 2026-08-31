# 예약 변경 확인 워크플로우 + 위약금 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 예약 변경 메일이 오면 즉시 덮어쓰지 않고 "변경 확인" 대기 큐에 올려 직원이 [기존 예약 유지]/[변경 확정]으로 처리하게 하고, 변경 시 위약금액을 표시한다.

**Architecture:** DB 함수 `ingest_reservation`에 변경 감지 분기를 넣어 변경분을 새 테이블 `reservation_changes`(pending 큐)에 적재한다. 대시보드는 새 `ReservationChangeQueue` 컴포넌트 + `reservation_changes` realtime 구독으로 큐를 보여주고, 두 개의 `security invoker` RPC(`keep_reservation_change` / `confirm_reservation_change`)로 처리한다. 위약금은 순수 TS 모듈 `lib/refund.ts`로 계산한다(스키마 영향 없음).

**Tech Stack:** Next.js 15.3 (App Router, RSC + server actions), Supabase(Postgres + Realtime), TypeScript, vitest(`TZ=UTC vitest run`).

## Global Constraints

- 날짜 문자열(`'YYYY-MM-DD'`) 계산은 **반드시** `new Date(iso + 'T00:00:00Z')` 로 파싱하고 `getUTC*` 게터로만 읽는다. `format.ts` 상단 주석 참조 — 파싱/게터 시간대를 섞으면 Vercel(UTC)에서 오프바이원 → `stats.ts` 무한루프 → OOM 전면 장애 재발.
- "오늘"은 항상 한국시간 기준. `lib/format.ts` 의 `kstTodayISO()` 를 쓴다.
- DB 함수 권한: 파싱 워커용 `ingest_reservation` 은 `revoke all ... from public` + `grant execute ... to service_role`. 대시보드 RPC 는 `security invoker` + `grant execute ... to authenticated` (기존 `0003_actions_fn.sql` 패턴).
- 감사 원칙: `reservation_events` append-only. 시스템 동작은 `actor = null`, 직원 동작은 `actor = auth.uid()`.
- 마이그레이션 파일은 번호 순서대로 Supabase SQL 에디터/`supabase db reset` 로 실행된다. 이번 작업은 **단일 파일** `supabase/migrations/0023_reservation_change_review.sql` 에 누적 작성한다(Task 3~5).
- 컴포넌트 단위 테스트는 이 저장소에 없다(RTL 미설치). 새 컴포넌트는 기존 패턴대로 무테스트 + 프리뷰로 육안 검증. 순수 로직(`lib/*.ts`)만 vitest 로 TDD.
- 게스트하우스 판별 규칙은 기존 그대로: `room_name like '객실 서쪽%' or '객실 남쪽%' or '서쪽방%' or '남쪽방%'` → 이 경우 `stayfolio` 막기 태스크는 생성하지 않는다.
- 상태 보존 원칙: 활성 예약 재수신 시 `reservations.status`/감사 필드는 건드리지 않는다. 이번 변경은 그 원칙을 유지하며 "확정" 시에만 상태를 재설정한다.

---

## File Structure

| 파일 | 책임 | 작업 |
|------|------|------|
| `lib/refund.ts` | 취소/변경 환불·위약금 계산(순수) | Create (Task 1) |
| `lib/refund.test.ts` | 위 테스트 | Create (Task 1) |
| `lib/reservation-change.ts` | prev/new 비교 → 바뀐 필드 목록·요약 라벨(순수) | Create (Task 2) |
| `lib/reservation-change.test.ts` | 위 테스트 | Create (Task 2) |
| `supabase/migrations/0023_reservation_change_review.sql` | 테이블 + `reservations` 컬럼 + `ingest_reservation` 재정의 + 2개 RPC + `block_tasks` unique 제거 | Create (Task 3→4→5 누적) |
| `lib/db-types.ts` | `ReservationChange` row 타입, `Reservation.prev_check_in/out` | Modify (Task 6) |
| `lib/queries.ts` | `getPendingReservationChanges()` | Modify (Task 6) |
| `lib/actions.ts` | `keepReservationChange()` / `confirmReservationChange()` server actions | Modify (Task 7) |
| `components/Badges.tsx` | `ChangeRequestBadge` | Modify (Task 8) |
| `components/ReservationChangeQueue.tsx` | 변경 대기 큐 섹션 + 위약금 배너 + 두 버튼 | Create (Task 8) |
| `components/ReservationList.tsx` | "변경 요청" 배지, "이전 …에서 변경" 줄 | Modify (Task 9) |
| `components/RoomCalendar.tsx` | "이전 …에서 변경" 줄 | Modify (Task 9) |
| `app/page.tsx` | `getPendingReservationChanges` 로드 → prop 전달 | Modify (Task 10) |
| `components/DashboardRealtime.tsx` | `changes` state + `reservation_changes` 구독 + 핸들러 + 섹션 렌더 + quick-nav | Modify (Task 10) |

---

## Task 1: `lib/refund.ts` — 환불/위약금 계산

**Files:**
- Create: `lib/refund.ts`
- Test: `lib/refund.test.ts`

**Interfaces:**
- Consumes: `lib/format.ts` 의 `kstTodayISO(): string`
- Produces:
  ```ts
  export interface RefundInfo {
    daysBefore: number;        // 오늘 → 기준 체크인, 정수(음수 가능)
    refundRate: number;        // 0 ~ 1
    refundable: number | null; // 환불 가능액(원). amount null이면 null
    penalty: number | null;    // 위약금(원). amount null이면 null
    hasPenalty: boolean;       // refundRate < 1
    amountKnown: boolean;      // totalAmount != null
  }
  export function daysUntil(targetISO: string, fromISO: string): number;
  export function refundRateForDaysBefore(daysBefore: number): number;
  export function refundForChange(
    baseCheckIn: string,
    totalAmount: number | null,
    todayISO?: string,        // 기본값 kstTodayISO()
  ): RefundInfo;
  ```

규정(체크인까지 남은 일수 → 환불율):

| 남은 일수 | 환불율 |
|---|---|
| ≥ 10 | 1.0 |
| 9 | 0.9 |
| 8 | 0.8 |
| 7 | 0.7 |
| 6 | 0.6 |
| 5 | 0.5 |
| 4 | 0.4 |
| ≤ 3 (0·음수 포함) | 0.0 |

`penalty = Math.round(total * (1 - rate))`, `refundable = total - penalty`.

- [ ] **Step 1: Write the failing test**

Create `lib/refund.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { daysUntil, refundRateForDaysBefore, refundForChange } from './refund';

describe('daysUntil', () => {
  it('UTC 자정 파싱으로 정수 일수 차이', () => {
    expect(daysUntil('2026-03-20', '2026-03-10')).toBe(10);
    expect(daysUntil('2026-03-10', '2026-03-10')).toBe(0);
    expect(daysUntil('2026-03-05', '2026-03-10')).toBe(-5);
  });
});

describe('refundRateForDaysBefore', () => {
  it('규정 표 그대로', () => {
    expect(refundRateForDaysBefore(11)).toBe(1);
    expect(refundRateForDaysBefore(10)).toBe(1);
    expect(refundRateForDaysBefore(9)).toBe(0.9);
    expect(refundRateForDaysBefore(8)).toBe(0.8);
    expect(refundRateForDaysBefore(7)).toBe(0.7);
    expect(refundRateForDaysBefore(6)).toBe(0.6);
    expect(refundRateForDaysBefore(5)).toBe(0.5);
    expect(refundRateForDaysBefore(4)).toBe(0.4);
    expect(refundRateForDaysBefore(3)).toBe(0);
    expect(refundRateForDaysBefore(0)).toBe(0);
    expect(refundRateForDaysBefore(-2)).toBe(0);
  });
});

describe('refundForChange', () => {
  it('10일 이상: 위약금 없음', () => {
    const r = refundForChange('2026-03-25', 150000, '2026-03-10'); // 15일 전
    expect(r.daysBefore).toBe(15);
    expect(r.refundRate).toBe(1);
    expect(r.hasPenalty).toBe(false);
    expect(r.penalty).toBe(0);
    expect(r.refundable).toBe(150000);
  });

  it('7일 전: 70% 환불 / 위약금 45,000', () => {
    const r = refundForChange('2026-03-17', 150000, '2026-03-10');
    expect(r.daysBefore).toBe(7);
    expect(r.refundRate).toBe(0.7);
    expect(r.hasPenalty).toBe(true);
    expect(r.penalty).toBe(45000);
    expect(r.refundable).toBe(105000);
  });

  it('3일 이하: 환불 불가 / 위약금 전액', () => {
    const r = refundForChange('2026-03-12', 150000, '2026-03-10');
    expect(r.daysBefore).toBe(2);
    expect(r.refundRate).toBe(0);
    expect(r.penalty).toBe(150000);
    expect(r.refundable).toBe(0);
  });

  it('반올림', () => {
    const r = refundForChange('2026-03-19', 12345, '2026-03-10'); // 9일 → 90%
    expect(r.penalty).toBe(Math.round(12345 * 0.1)); // 1235 (1234.5 반올림)
    expect(r.refundable).toBe(12345 - 1235);
  });

  it('금액 미상: penalty/refundable null, amountKnown false', () => {
    const r = refundForChange('2026-03-17', null, '2026-03-10');
    expect(r.amountKnown).toBe(false);
    expect(r.penalty).toBeNull();
    expect(r.refundable).toBeNull();
    expect(r.hasPenalty).toBe(true); // 구간상 위약금 발생
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC npx vitest run lib/refund.test.ts`
Expected: FAIL — `Cannot find module './refund'` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `lib/refund.ts`:

```ts
// 취소(변경)/환불 규정 계산 — 순수 함수. 스키마·DB 영향 없음(표시 전용).
// 규정: 체크인까지 남은 일수로 환불율이 정해지고, 위약금 = 총액 × (1 - 환불율).
//
// 날짜 계산은 format.ts 규칙 준수: 'T00:00:00Z' 파싱 + getUTC* 만.
import { kstTodayISO } from './format';

export interface RefundInfo {
  daysBefore: number;
  refundRate: number;
  refundable: number | null;
  penalty: number | null;
  hasPenalty: boolean;
  amountKnown: boolean;
}

/** targetISO - fromISO 를 '일' 단위 정수로. 둘 다 'YYYY-MM-DD'. */
export function daysUntil(targetISO: string, fromISO: string): number {
  const t = new Date(targetISO + 'T00:00:00Z').getTime();
  const f = new Date(fromISO + 'T00:00:00Z').getTime();
  return Math.round((t - f) / 86_400_000);
}

const RATE_BY_DAYS: Record<number, number> = {
  9: 0.9, 8: 0.8, 7: 0.7, 6: 0.6, 5: 0.5, 4: 0.4,
};

/** 체크인까지 남은 일수 → 환불율(0~1). */
export function refundRateForDaysBefore(daysBefore: number): number {
  if (daysBefore >= 10) return 1;
  if (daysBefore <= 3) return 0;
  return RATE_BY_DAYS[daysBefore] ?? 0;
}

/**
 * @param baseCheckIn 위약금 기준이 되는 체크인('YYYY-MM-DD') — 보통 변경 전(직전) 체크인.
 * @param totalAmount 총 결제금액(원, 옵션 포함). 모르면 null.
 * @param todayISO 기준일(기본: 한국시간 오늘).
 */
export function refundForChange(
  baseCheckIn: string,
  totalAmount: number | null,
  todayISO: string = kstTodayISO(),
): RefundInfo {
  const daysBefore = daysUntil(baseCheckIn, todayISO);
  const refundRate = refundRateForDaysBefore(daysBefore);
  const amountKnown = totalAmount != null;
  const penalty = amountKnown
    ? Math.round((totalAmount as number) * (1 - refundRate))
    : null;
  const refundable =
    amountKnown && penalty != null ? (totalAmount as number) - penalty : null;
  return {
    daysBefore,
    refundRate,
    refundable,
    penalty,
    hasPenalty: refundRate < 1,
    amountKnown,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TZ=UTC npx vitest run lib/refund.test.ts`
Expected: PASS (5 describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add lib/refund.ts lib/refund.test.ts
git commit -m "feat: 취소/변경 위약금 계산 모듈(lib/refund.ts)"
```

---

## Task 2: `lib/reservation-change.ts` — 바뀐 필드 판별

**Files:**
- Create: `lib/reservation-change.ts`
- Test: `lib/reservation-change.test.ts`

**Interfaces:**
- Consumes: `lib/types.ts` 의 `ReservationOption`
- Produces:
  ```ts
  export type ChangedField = 'dates' | 'room' | 'amount' | 'guest' | 'options';
  export interface ChangeSnapshot {
    check_in: string;
    check_out: string;
    room_name: string | null;
    amount: number | null;
    guest_name: string | null;
    guest_phone?: string | null;
    options: ReservationOption[];
  }
  export function changedFields(prev: ChangeSnapshot, next: ChangeSnapshot): ChangedField[];
  export function changeSummaryLabel(fields: ChangedField[]): string; // 예: "날짜·금액 변경"
  ```

판별 규칙(DB `ingest_reservation` 의 `v_changed` 와 의미 일치):
- `dates`: `check_in` 또는 `check_out` 다름
- `room`: `room_name` 다름
- `amount`: `next.amount != null && next.amount !== prev.amount`
- `guest`: `guest_name` 다름 또는 (`next.guest_phone != null && next.guest_phone !== prev.guest_phone`)
- `options`: 정규화(JSON) 비교로 다름. 빈 배열 `next.options` 는 "변경 아님"으로 취급.

라벨: `{dates:'날짜', room:'객실', amount:'금액', guest:'예약자', options:'옵션'}` 를 `·` 로 이어 `"… 변경"`.

- [ ] **Step 1: Write the failing test**

Create `lib/reservation-change.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { changedFields, changeSummaryLabel } from './reservation-change';
import type { ChangeSnapshot } from './reservation-change';

const base: ChangeSnapshot = {
  check_in: '2026-03-09',
  check_out: '2026-03-10',
  room_name: '객실 서쪽',
  amount: 150000,
  guest_name: '홍길동',
  guest_phone: '010-1111-2222',
  options: [],
};

describe('changedFields', () => {
  it('동일하면 빈 배열', () => {
    expect(changedFields(base, { ...base })).toEqual([]);
  });
  it('날짜 변경', () => {
    expect(changedFields(base, { ...base, check_in: '2026-03-20', check_out: '2026-03-21' }))
      .toEqual(['dates']);
  });
  it('객실 변경', () => {
    expect(changedFields(base, { ...base, room_name: '객실 남쪽' })).toEqual(['room']);
  });
  it('금액: null이면 변경 아님, 값 다르면 변경', () => {
    expect(changedFields(base, { ...base, amount: null })).toEqual([]);
    expect(changedFields(base, { ...base, amount: 120000 })).toEqual(['amount']);
  });
  it('예약자: 전화 null이면 무시, 이름 다르면 변경', () => {
    expect(changedFields(base, { ...base, guest_phone: null })).toEqual([]);
    expect(changedFields(base, { ...base, guest_name: '김철수' })).toEqual(['guest']);
  });
  it('옵션: 빈 배열이면 변경 아님, 내용 다르면 변경', () => {
    expect(changedFields(base, { ...base, options: [] })).toEqual([]);
    expect(changedFields(base, { ...base, options: [{ name: '조식', qty: 2, price: 12000 }] }))
      .toEqual(['options']);
  });
  it('복합 변경은 정해진 순서로', () => {
    expect(
      changedFields(base, {
        ...base,
        check_in: '2026-03-20',
        amount: 99000,
      }),
    ).toEqual(['dates', 'amount']);
  });
});

describe('changeSummaryLabel', () => {
  it('라벨 이어붙이기', () => {
    expect(changeSummaryLabel(['dates'])).toBe('날짜 변경');
    expect(changeSummaryLabel(['dates', 'amount'])).toBe('날짜·금액 변경');
    expect(changeSummaryLabel([])).toBe('변경 없음');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC npx vitest run lib/reservation-change.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/reservation-change.ts`:

```ts
// prev/new 예약 스냅샷을 비교해 "무엇이 바뀌었나"를 낸다 — 변경 확인 큐 카드 라벨용.
// DB의 ingest_reservation v_changed 판정과 의미를 맞춘다(빈 옵션/‌null 금액·전화는 변경 아님).
import type { ReservationOption } from './types';

export type ChangedField = 'dates' | 'room' | 'amount' | 'guest' | 'options';

export interface ChangeSnapshot {
  check_in: string;
  check_out: string;
  room_name: string | null;
  amount: number | null;
  guest_name: string | null;
  guest_phone?: string | null;
  options: ReservationOption[];
}

function normOptions(opts: ReservationOption[]): string {
  return JSON.stringify(
    [...(opts ?? [])]
      .map((o) => ({ name: o.name, qty: o.qty, price: o.price }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

const ORDER: ChangedField[] = ['dates', 'room', 'amount', 'guest', 'options'];

const LABEL: Record<ChangedField, string> = {
  dates: '날짜',
  room: '객실',
  amount: '금액',
  guest: '예약자',
  options: '옵션',
};

export function changedFields(
  prev: ChangeSnapshot,
  next: ChangeSnapshot,
): ChangedField[] {
  const set = new Set<ChangedField>();

  if (prev.check_in !== next.check_in || prev.check_out !== next.check_out) {
    set.add('dates');
  }
  if (prev.room_name !== next.room_name) set.add('room');
  if (next.amount != null && next.amount !== prev.amount) set.add('amount');
  if (
    prev.guest_name !== next.guest_name ||
    (next.guest_phone != null && next.guest_phone !== prev.guest_phone)
  ) {
    set.add('guest');
  }
  const nextOpts = next.options ?? [];
  if (nextOpts.length > 0 && normOptions(prev.options) !== normOptions(nextOpts)) {
    set.add('options');
  }

  return ORDER.filter((f) => set.has(f));
}

export function changeSummaryLabel(fields: ChangedField[]): string {
  if (fields.length === 0) return '변경 없음';
  return fields.map((f) => LABEL[f]).join('·') + ' 변경';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TZ=UTC npx vitest run lib/reservation-change.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reservation-change.ts lib/reservation-change.test.ts
git commit -m "feat: 예약 변경 필드 판별 헬퍼(lib/reservation-change.ts)"
```

---

## Task 3: 마이그레이션 `0023` — 테이블 + 컬럼 + `block_tasks` unique 제거

**Files:**
- Create: `supabase/migrations/0023_reservation_change_review.sql`

**Interfaces:**
- Produces (later tasks/queries rely on):
  - table `reservation_changes` — 컬럼은 아래 SQL 그대로
  - `reservations.prev_check_in date`, `reservations.prev_check_out date` (both nullable)
  - `block_tasks` 의 `unique (reservation_id, target_channel)` 제거됨 → 한 예약·한 채널에 여러 태스크 허용(변경 확정 시 "옛 날짜 다시 열기" + "새 날짜 막기" 공존).

- [ ] **Step 1: Write the migration file (this section)**

Create `supabase/migrations/0023_reservation_change_review.sql` with exactly:

```sql
-- 예약 변경 확인 워크플로우.
--
-- 지금까지: 같은 예약번호로 변경 메일이 오면 ingest_reservation이 check_in/out 등을 즉시
-- 덮어썼다 → 원래 날짜·이력 유실, 새 날짜 막기 태스크 미생성.
--
-- 이제: 변경분을 reservation_changes(pending 큐)에 적재하고 예약 본체는 그대로 둔다.
-- 직원이 대시보드에서 [기존 예약 유지] 또는 [변경 확정]을 누를 때 반영한다.
-- 손님이 원래 값으로 되돌리면(들어온 값 == 현재 예약) pending 큐 건을 자동 철회(withdrawn).

-- ── 1) 변경 대기 큐 ────────────────────────────────────────────────
create table reservation_changes (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,

  -- 확정 "직전" 스냅샷(option B). 재변경 시 최초값이 아니라 그때의 현재값으로 갱신됨은 아니고,
  -- pending 1건이 유지되는 동안 prev_*는 최초 진입 시점(=확정 전 예약 상태)으로 고정된다.
  prev_check_in   date    not null,
  prev_check_out  date    not null,
  prev_room_name  text,
  prev_amount     integer,
  prev_guest_name text,
  prev_options    jsonb   not null default '[]'::jsonb,

  -- 들어온 새 값(파서 출력 그대로)
  new_guest_name     text,
  new_guest_phone    text,
  new_room_name      text,
  new_check_in       date not null,
  new_check_out      date not null,
  new_amount         integer,
  new_options        jsonb not null default '[]'::jsonb,
  new_payment_method payment_method not null,
  new_payment_status payment_status not null,
  new_raw_payload    jsonb,

  status      text not null default 'pending'
              check (status in ('pending','confirmed','kept','withdrawn')),
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 한 예약에 열려있는(pending) 변경은 항상 1건 — upsert 대상.
create unique index reservation_changes_one_pending
  on reservation_changes (reservation_id) where status = 'pending';
create index reservation_changes_status_idx
  on reservation_changes (status, new_check_in);

create trigger reservation_changes_set_updated_at
  before update on reservation_changes
  for each row execute function set_updated_at();

alter table reservation_changes enable row level security;
create policy "authed full reservation_changes"
  on reservation_changes for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table reservation_changes;

-- ── 2) reservations: 확정된 변경의 직전 날짜 보관(카드 "이전 …에서 변경") ──
alter table reservations add column prev_check_in  date;
alter table reservations add column prev_check_out date;

-- ── 3) block_tasks: (reservation_id, target_channel) unique 제거 ──
-- 변경 확정 시 한 채널에 "옛 날짜 다시 열기"와 "새 날짜 막기"가 동시에 필요.
-- 이 쌍에 대한 ON CONFLICT 사용처는 코드베이스에 없음(확인함) → 조회용 일반 인덱스로 대체.
alter table block_tasks drop constraint block_tasks_reservation_id_target_channel_key;
create index block_tasks_res_channel_idx on block_tasks (reservation_id, target_channel);
```

- [ ] **Step 2: Apply locally and verify schema**

Run:
```bash
supabase db reset
```
Expected: 모든 마이그레이션이 `0023...` 까지 에러 없이 적용됨. 마지막 줄에 `Finished supabase db reset.`

Then verify:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d reservation_changes" \
  -c "\d+ reservations" \
  -c "select conname from pg_constraint where conrelid='block_tasks'::regclass;"
```
Expected:
- `reservation_changes` 테이블에 위 컬럼들 + `reservation_changes_one_pending` 부분 유니크 인덱스.
- `reservations` 에 `prev_check_in`, `prev_check_out` (date, nullable).
- `block_tasks` 제약 목록에 `block_tasks_reservation_id_target_channel_key` **없음**, `block_tasks_manual_or_reservation` (0011) 는 그대로 있음.

> `supabase` CLI/Docker 를 못 쓰는 환경이면: 같은 SQL 을 Supabase 프로젝트의 스테이징 브랜치 SQL 에디터에서 실행하고 같은 `\d` 확인을 GUI 로 대체한다.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0023_reservation_change_review.sql
git commit -m "feat: reservation_changes 큐 테이블 + reservations.prev_* + block_tasks unique 제거"
```

---

## Task 4: 마이그레이션 `0023` — `ingest_reservation` 변경 감지 분기

**Files:**
- Modify: `supabase/migrations/0023_reservation_change_review.sql` (append)

**Interfaces:**
- Consumes: Task 3 의 `reservation_changes` 테이블, `reservations.prev_*` (미사용), `event_type` enum 값 `'updated'`/`'note'`/`'detected'` (0001 에 이미 존재).
- Produces: `ingest_reservation(...)` 재정의 — 시그니처(파라미터 13개, 마지막 `p_cancelled boolean default false`)와 권한은 기존과 동일. 동작:
  - **신규**(기존행 없음): 기존과 동일 — insert + `detected` 이벤트 + 다른 채널 `block_tasks`(게스트하우스-stayfolio 제외).
  - **취소 메일**(`p_cancelled`): 기존과 동일(upsert + `cancelled` 이벤트 + pending→skipped / done→unblock) + 해당 예약의 pending `reservation_changes` 를 `withdrawn` 처리.
  - **활성 재수신 & 값 변경**: `reservations` 는 `raw_payload` 만 갱신, `reservation_changes` 에 pending upsert, `updated` 이벤트.
  - **활성 재수신 & 값 동일**: `raw_payload` 만 갱신. pending `reservation_changes` 가 있으면 `withdrawn` + `note` 이벤트(손님 원복).

- [ ] **Step 1: Append the function redefinition**

Append to `supabase/migrations/0023_reservation_change_review.sql`:

```sql
-- ── 4) ingest_reservation: 변경 감지 분기 ─────────────────────────
-- 베이스는 0014_unblock_on_cancel.sql 의 정의. ON CONFLICT 한 방 upsert 대신
-- "기존 행 조회 → 분기"로 재구성한다(변경분은 예약을 안 건드리고 큐로 보내야 하므로).
create or replace function ingest_reservation(
  p_channel                channel,
  p_channel_reservation_id text,
  p_guest_name             text,
  p_guest_phone            text,
  p_room_name              text,
  p_check_in               date,
  p_check_out              date,
  p_amount                 integer,
  p_options                jsonb,
  p_payment_method         payment_method,
  p_payment_status         payment_status,
  p_raw                    jsonb,
  p_cancelled              boolean default false
) returns uuid
language plpgsql
security definer
as $$
declare
  v_id            uuid;
  v_exists        boolean;
  v_was_cancelled boolean;
  v_status        reservation_status;
  v_is_guesthouse boolean;
  v_existing      reservations%rowtype;
  v_changed       boolean;
  v_opts          jsonb := coalesce(p_options, '[]'::jsonb);
  v_withdrawn     boolean;
begin
  v_status := case
    when p_cancelled then 'cancelled'
    when p_payment_status = 'paid' then 'confirmed'
    when p_payment_status = 'pending' then 'awaiting_deposit'
    else 'new'
  end::reservation_status;

  v_is_guesthouse := p_room_name like '객실 서쪽%' or p_room_name like '객실 남쪽%'
                   or p_room_name like '서쪽방%' or p_room_name like '남쪽방%';

  select * into v_existing
    from reservations
   where channel = p_channel and channel_reservation_id = p_channel_reservation_id;
  v_exists := found;
  v_was_cancelled := v_exists and v_existing.status = 'cancelled';

  -- ── A) 신규 예약 ──
  if not v_exists then
    insert into reservations (
      channel, channel_reservation_id, guest_name, guest_phone, room_name,
      check_in, check_out, amount, options,
      payment_method, payment_status, status,
      cancelled_at, raw_payload
    ) values (
      p_channel, p_channel_reservation_id, p_guest_name, p_guest_phone, p_room_name,
      p_check_in, p_check_out, p_amount, v_opts,
      p_payment_method, p_payment_status, v_status,
      case when p_cancelled then now() end, p_raw
    )
    returning id into v_id;

    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'detected',
              jsonb_build_object('channel', p_channel, 'payment_status', p_payment_status,
                                 'cancelled_on_arrival', p_cancelled));

    if not p_cancelled then
      insert into block_tasks (reservation_id, target_channel, check_in, check_out)
        select v_id, c, p_check_in, p_check_out
        from unnest(enum_range(null::channel)) as c
        where c <> p_channel
          and not (v_is_guesthouse and c = 'stayfolio'::channel);
    end if;

    return v_id;
  end if;

  v_id := v_existing.id;

  -- ── B) 취소 메일 ──
  if p_cancelled then
    update reservations set
      guest_name     = p_guest_name,
      guest_phone    = coalesce(p_guest_phone, guest_phone),
      room_name      = p_room_name,
      check_in       = p_check_in,
      check_out      = p_check_out,
      amount         = coalesce(p_amount, amount),
      options        = case when v_opts <> '[]'::jsonb then v_opts else options end,
      payment_method = p_payment_method,
      payment_status = p_payment_status,
      status         = 'cancelled',
      cancelled_at   = coalesce(cancelled_at, now()),
      raw_payload    = p_raw
    where id = v_id;

    if not coalesce(v_was_cancelled, false) then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'cancelled', jsonb_build_object('source', 'channel_notification'));

      update block_tasks set status = 'skipped'
       where reservation_id = v_id and status = 'pending';
      update block_tasks set status = 'pending', action = 'unblock'
       where reservation_id = v_id and status = 'done';
    end if;

    -- 취소가 우선 — 열려있던 변경 대기는 철회.
    update reservation_changes
       set status = 'withdrawn', resolved_at = now()
     where reservation_id = v_id and status = 'pending';

    return v_id;
  end if;

  -- ── C) 활성 예약 재수신 ──
  v_changed :=
       p_check_in   is distinct from v_existing.check_in
    or p_check_out  is distinct from v_existing.check_out
    or p_room_name  is distinct from v_existing.room_name
    or p_guest_name is distinct from v_existing.guest_name
    or (p_amount is not null      and p_amount      is distinct from v_existing.amount)
    or (p_guest_phone is not null and p_guest_phone is distinct from v_existing.guest_phone)
    or (v_opts <> '[]'::jsonb     and v_opts        is distinct from coalesce(v_existing.options, '[]'::jsonb));

  -- 원문은 어느 쪽이든 최신으로 보존(재파싱·감사).
  update reservations set raw_payload = p_raw where id = v_id;

  if v_changed then
    insert into reservation_changes (
      reservation_id,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id,
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options, '[]'::jsonb),
      p_guest_name, p_guest_phone, p_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set
      new_guest_name     = excluded.new_guest_name,
      new_guest_phone    = excluded.new_guest_phone,
      new_room_name      = excluded.new_room_name,
      new_check_in       = excluded.new_check_in,
      new_check_out      = excluded.new_check_out,
      new_amount         = excluded.new_amount,
      new_options        = excluded.new_options,
      new_payment_method = excluded.new_payment_method,
      new_payment_status = excluded.new_payment_status,
      new_raw_payload    = excluded.new_raw_payload,
      updated_at         = now();

    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'updated',
              jsonb_build_object(
                'source', 'channel_notification',
                'from', jsonb_build_object('check_in', v_existing.check_in, 'check_out', v_existing.check_out,
                                           'room_name', v_existing.room_name, 'amount', v_existing.amount),
                'to',   jsonb_build_object('check_in', p_check_in, 'check_out', p_check_out,
                                           'room_name', p_room_name, 'amount', p_amount)));
  else
    -- 값 동일: 손님이 원래대로 되돌린 경우 대기 건 자동 철회.
    update reservation_changes
       set status = 'withdrawn', resolved_at = now()
     where reservation_id = v_id and status = 'pending';
    v_withdrawn := found;

    if v_withdrawn then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note',
                jsonb_build_object('note', '손님이 원래 예약 내용으로 되돌림 — 변경 요청 자동 철회'));
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean
) from public;
grant execute on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean
) to service_role;
```

- [ ] **Step 2: Write a SQL scenario script**

Create `scripts/verify-0023.sql` (temporary verification harness, committed for reuse):

```sql
-- 0023 검증 시나리오. supabase db reset 후 실행.
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f scripts/verify-0023.sql
\set ON_ERROR_STOP on
begin;

-- 헬퍼: ingest_reservation 호출 축약
create or replace function _t_ing(cid text, ci date, co date, amt int default 150000,
                                  room text default 'page26', cancelled bool default false)
returns uuid language sql as $$
  select ingest_reservation('naver'::channel, cid, '홍길동', '010-1', room,
    ci, co, amt, '[]'::jsonb, 'cash'::payment_method,
    'pending'::payment_status, jsonb_build_object('t', now()), cancelled);
$$;

-- 1) 신규
select _t_ing('R1', date '2026-03-09', date '2026-03-10');
select 'new: reservations=1?' as check, count(*)=1 from reservations where channel_reservation_id='R1';
select 'new: block_tasks(naver 제외 2)?' as check, count(*)=2 from block_tasks bt
  join reservations r on r.id=bt.reservation_id where r.channel_reservation_id='R1';
select 'new: changes=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id where r.channel_reservation_id='R1';

-- 2) 동일 재수신 → no-op (changes 0)
select _t_ing('R1', date '2026-03-09', date '2026-03-10');
select 'resend same: changes still 0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id where r.channel_reservation_id='R1';

-- 3) 날짜 변경 → pending 1건, 예약 본체 불변
select _t_ing('R1', date '2026-03-20', date '2026-03-21');
select 'change: pending=1?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';
select 'change: 예약 날짜 그대로 3/9?' as check, check_in = date '2026-03-09'
  from reservations where channel_reservation_id='R1';
select 'change: updated 이벤트?' as check, count(*)=1 from reservation_events ev
  join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='R1' and ev.type='updated';

-- 4) 또 다른 날짜 → 같은 pending 행 갱신(여전히 1건), prev는 3/9 유지
select _t_ing('R1', date '2026-03-25', date '2026-03-26');
select 'change2: pending 여전히 1?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';
select 'change2: new_check_in=3/25 & prev_check_in=3/9?' as check,
  bool_and(rc.new_check_in=date '2026-03-25' and rc.prev_check_in=date '2026-03-09')
  from reservation_changes rc join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';

-- 5) 원래 값으로 되돌림 → pending withdrawn
select _t_ing('R1', date '2026-03-09', date '2026-03-10');
select 'revert: pending=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';
select 'revert: withdrawn=1?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='withdrawn';

-- 6) 취소 메일: pending이 있어도 함께 withdrawn
select _t_ing('R1', date '2026-04-01', date '2026-04-02');           -- pending 재생성
select _t_ing('R1', date '2026-04-01', date '2026-04-02', cancelled => true);
select 'cancel: 예약 status=cancelled?' as check, status='cancelled'
  from reservations where channel_reservation_id='R1';
select 'cancel: pending=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';

drop function _t_ing(text,date,date,int,text,bool);
rollback;
```

- [ ] **Step 3: Run the scenario**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f scripts/verify-0023.sql
```
Expected: 모든 `check` 행의 두 번째 컬럼이 `t`. `f` 가 하나라도 있으면 그 시나리오 로직을 고친다(함수 재정의 → `supabase db reset` 재실행).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0023_reservation_change_review.sql scripts/verify-0023.sql
git commit -m "feat: ingest_reservation 변경 감지 분기 — 변경분을 reservation_changes 큐로"
```

---

## Task 5: 마이그레이션 `0023` — 두 처리 RPC

**Files:**
- Modify: `supabase/migrations/0023_reservation_change_review.sql` (append)
- Modify: `scripts/verify-0023.sql` (append RPC 시나리오)

**Interfaces:**
- Consumes: Task 3/4 산출물.
- Produces:
  - `keep_reservation_change(p_change_id uuid) returns void` — `security invoker`, grant to `authenticated`. pending 건을 `kept` 로 마감 + `note` 이벤트. 예약·태스크 불변.
  - `confirm_reservation_change(p_change_id uuid) returns void` — `security invoker`, grant to `authenticated`. 예약 본체 in-place 갱신(같은 id, `notes` 보존, 상태 재트리아지, `prev_check_in/out` 기록) + 옛 날짜 `block_tasks`(pending→skipped, done→pending/unblock) + 새 날짜 `block_tasks`(pending/block, 게스트하우스-stayfolio 제외) + `detected`·`note` 이벤트 + 큐 행 `confirmed`.

- [ ] **Step 1: Append the two functions**

Append to `supabase/migrations/0023_reservation_change_review.sql`:

```sql
-- ── 5) [기존 예약 유지] ──────────────────────────────────────────
create or replace function keep_reservation_change(p_change_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_uid  uuid := auth.uid();
  v_res  uuid;
  v_from jsonb;
  v_to   jsonb;
begin
  update reservation_changes
     set status = 'kept', resolved_by = v_uid, resolved_at = now()
   where id = p_change_id and status = 'pending'
   returning reservation_id,
             jsonb_build_object('check_in', prev_check_in, 'check_out', prev_check_out,
                                'room_name', prev_room_name, 'amount', prev_amount),
             jsonb_build_object('check_in', new_check_in, 'check_out', new_check_out,
                                'room_name', new_room_name, 'amount', new_amount)
      into v_res, v_from, v_to;

  if v_res is not null then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_res, v_uid, 'note',
              jsonb_build_object('note', '예약 변경 요청 거절 — 기존 예약 유지',
                                 'from', v_from, 'to', v_to));
  end if;
end;
$$;
grant execute on function keep_reservation_change(uuid) to authenticated;

-- ── 6) [변경 확정] ──────────────────────────────────────────────
create or replace function confirm_reservation_change(p_change_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_uid           uuid := auth.uid();
  c               reservation_changes%rowtype;
  r               reservations%rowtype;
  v_new_status    reservation_status;
  v_is_guesthouse boolean;
begin
  select * into c from reservation_changes where id = p_change_id and status = 'pending';
  if not found then return; end if;

  select * into r from reservations where id = c.reservation_id;
  if not found then return; end if;

  v_new_status := case
    when c.new_payment_status = 'paid'    then 'confirmed'
    when c.new_payment_status = 'pending' then 'awaiting_deposit'
    else 'new'
  end::reservation_status;

  v_is_guesthouse := c.new_room_name like '객실 서쪽%' or c.new_room_name like '객실 남쪽%'
                   or c.new_room_name like '서쪽방%'   or c.new_room_name like '남쪽방%';

  -- 6a) 예약 본체 in-place 갱신(id 유지). notes(직원 메모)는 건드리지 않음.
  update reservations set
    guest_name     = c.new_guest_name,
    guest_phone    = coalesce(c.new_guest_phone, guest_phone),
    room_name      = c.new_room_name,
    check_in       = c.new_check_in,
    check_out      = c.new_check_out,
    amount         = coalesce(c.new_amount, amount),
    options        = c.new_options,
    payment_method = c.new_payment_method,
    payment_status = c.new_payment_status,
    status         = v_new_status,
    prev_check_in  = c.prev_check_in,
    prev_check_out = c.prev_check_out,
    deposit_confirmed_by = null,
    deposit_confirmed_at = null,
    confirmed_by   = null,
    confirmed_at   = null,
    cancelled_by   = null,
    cancelled_at   = null,
    raw_payload    = coalesce(c.new_raw_payload, raw_payload)
  where id = c.reservation_id;

  -- 6b) 옛 날짜 정리: 아직 안 막은 건 제거, 이미 막은 건 "다시 열기"로.
  update block_tasks set status = 'skipped'
   where reservation_id = c.reservation_id and status = 'pending' and action = 'block';
  update block_tasks set status = 'pending', action = 'unblock'
   where reservation_id = c.reservation_id and status = 'done' and action = 'block';

  -- 6c) 새 날짜 "막아라" 태스크(다른 채널). block_tasks unique 제거됨(0023 §3)이라 공존 가능.
  insert into block_tasks (reservation_id, target_channel, check_in, check_out, action, status)
    select c.reservation_id, ch2, c.new_check_in, c.new_check_out, 'block', 'pending'
    from unnest(enum_range(null::channel)) as ch2
    where ch2 <> r.channel
      and not (v_is_guesthouse and ch2 = 'stayfolio'::channel);

  -- 6d) 이벤트
  insert into reservation_events (reservation_id, actor, type, detail) values
    (c.reservation_id, v_uid, 'detected',
     jsonb_build_object('source', 'reservation_change',
        'from', jsonb_build_object('check_in', c.prev_check_in, 'check_out', c.prev_check_out),
        'to',   jsonb_build_object('check_in', c.new_check_in,  'check_out', c.new_check_out))),
    (c.reservation_id, v_uid, 'note', jsonb_build_object('note', '예약 변경 확정'));

  -- 6e) 큐 행 마감
  update reservation_changes
     set status = 'confirmed', resolved_by = v_uid, resolved_at = now()
   where id = p_change_id;
end;
$$;
grant execute on function confirm_reservation_change(uuid) to authenticated;
```

- [ ] **Step 2: Append RPC scenario to `scripts/verify-0023.sql`**

Insert **before** the final `drop function _t_ing...` line:

```sql
-- ── RPC: confirm ──
select _t_ing('R2', date '2026-05-10', date '2026-05-11');            -- 신규
-- naver 예약이므로 stayfolio/imweb 막기 2건 생성됨. 하나를 "막음(done)"으로.
update block_tasks set status='done', action='block'
 where reservation_id=(select id from reservations where channel_reservation_id='R2')
   and target_channel='imweb';
select _t_ing('R2', date '2026-05-20', date '2026-05-21');            -- 변경 → pending
select confirm_reservation_change(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='R2' and rc.status='pending'));

select 'confirm: 예약 날짜=5/20?' as check, check_in=date '2026-05-20'
  from reservations where channel_reservation_id='R2';
select 'confirm: prev_check_in=5/10?' as check, prev_check_in=date '2026-05-10'
  from reservations where channel_reservation_id='R2';
select 'confirm: 큐 confirmed?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R2' and rc.status='confirmed';
select 'confirm: imweb 다시열기(unblock,pending)?' as check, count(*)=1 from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='R2')
    and target_channel='imweb' and action='unblock' and status='pending';
select 'confirm: 새 날짜 block pending 존재(imweb 5/20)?' as check, count(*)>=1 from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='R2')
    and target_channel='imweb' and action='block' and status='pending'
    and check_in=date '2026-05-20';

-- ── RPC: keep ──
select _t_ing('R3', date '2026-06-10', date '2026-06-11');
select _t_ing('R3', date '2026-06-20', date '2026-06-21');            -- 변경 → pending
select keep_reservation_change(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='R3' and rc.status='pending'));
select 'keep: 큐 kept?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R3' and rc.status='kept';
select 'keep: 예약 날짜 그대로 6/10?' as check, check_in=date '2026-06-10'
  from reservations where channel_reservation_id='R3';
```

- [ ] **Step 3: Run full scenario**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f scripts/verify-0023.sql
```
Expected: 모든 `check` 결과가 `t`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0023_reservation_change_review.sql scripts/verify-0023.sql
git commit -m "feat: keep_reservation_change / confirm_reservation_change RPC"
```

---

## Task 6: `lib/db-types.ts` + `lib/queries.ts` — 타입 & 조회

**Files:**
- Modify: `lib/db-types.ts` (add `ReservationChange`, extend `Reservation`)
- Modify: `lib/queries.ts` (add `getPendingReservationChanges`)

**Interfaces:**
- Consumes: `SupabaseClient`, Task 3 스키마.
- Produces:
  ```ts
  // db-types.ts
  export interface Reservation { /* ...기존... */ prev_check_in: string | null; prev_check_out: string | null; }
  export interface ReservationChange {
    id: string;
    reservation_id: string;
    reservation_channel: Channel;        // 조인
    reservation_notes: string | null;    // 조인(참고 표시용)
    prev_check_in: string; prev_check_out: string;
    prev_room_name: string | null; prev_amount: number | null;
    prev_guest_name: string | null; prev_options: ReservationOption[];
    new_guest_name: string | null; new_guest_phone: string | null;
    new_room_name: string | null;
    new_check_in: string; new_check_out: string;
    new_amount: number | null; new_options: ReservationOption[];
    new_payment_method: PaymentMethod; new_payment_status: PaymentStatus;
    status: 'pending' | 'confirmed' | 'kept' | 'withdrawn';
    created_at: string;
  }
  // queries.ts
  export async function getPendingReservationChanges(supabase: SupabaseClient): Promise<ReservationChange[]>;
  ```

- [ ] **Step 1: Extend `Reservation` and add `ReservationChange` in `lib/db-types.ts`**

In `lib/db-types.ts`, add two fields to `interface Reservation` right after `check_out: string;` (line ~21):

```ts
  check_out: string;
  prev_check_in: string | null;   // 확정된 변경의 직전 체크인(있으면 카드에 "이전 …에서 변경")
  prev_check_out: string | null;
```

Add import for `PaymentMethod` if not present (it isn't — current import only pulls a subset). Change the top import block:

```ts
import type {
  Channel,
  PaymentMethod,
  PaymentStatus,
  ReservationStatus,
  ReservationOption,
} from './types';
```

Then append at end of file:

```ts
export type ReservationChangeStatus = 'pending' | 'confirmed' | 'kept' | 'withdrawn';

// reservation_changes 큐 행 + reservations 조인 몇 개(표시용).
export interface ReservationChange {
  id: string;
  reservation_id: string;
  reservation_channel: Channel;
  reservation_notes: string | null;

  prev_check_in: string;
  prev_check_out: string;
  prev_room_name: string | null;
  prev_amount: number | null;
  prev_guest_name: string | null;
  prev_options: ReservationOption[];

  new_guest_name: string | null;
  new_guest_phone: string | null;
  new_room_name: string | null;
  new_check_in: string;
  new_check_out: string;
  new_amount: number | null;
  new_options: ReservationOption[];
  new_payment_method: PaymentMethod;
  new_payment_status: PaymentStatus;

  status: ReservationChangeStatus;
  created_at: string;
}
```

- [ ] **Step 2: Add `getPendingReservationChanges` to `lib/queries.ts`**

Append to `lib/queries.ts`:

```ts
interface ReservationChangeRow {
  id: string;
  reservation_id: string;
  prev_check_in: string; prev_check_out: string;
  prev_room_name: string | null; prev_amount: number | null;
  prev_guest_name: string | null; prev_options: ReservationChange['prev_options'];
  new_guest_name: string | null; new_guest_phone: string | null;
  new_room_name: string | null;
  new_check_in: string; new_check_out: string;
  new_amount: number | null; new_options: ReservationChange['new_options'];
  new_payment_method: ReservationChange['new_payment_method'];
  new_payment_status: ReservationChange['new_payment_status'];
  status: ReservationChange['status'];
  created_at: string;
  reservation: { channel: Channel; notes: string | null } | null;
}

// 변경 확인 큐 — pending 만, 새 체크인 빠른 순.
export async function getPendingReservationChanges(
  supabase: SupabaseClient,
): Promise<ReservationChange[]> {
  const { data, error } = await supabase
    .from('reservation_changes')
    .select('*, reservation:reservations(channel, notes)')
    .eq('status', 'pending')
    .order('new_check_in', { ascending: true });
  if (error) throw error;

  return ((data ?? []) as unknown as ReservationChangeRow[]).map((row) => ({
    id: row.id,
    reservation_id: row.reservation_id,
    reservation_channel: row.reservation?.channel ?? 'naver',
    reservation_notes: row.reservation?.notes ?? null,
    prev_check_in: row.prev_check_in,
    prev_check_out: row.prev_check_out,
    prev_room_name: row.prev_room_name,
    prev_amount: row.prev_amount,
    prev_guest_name: row.prev_guest_name,
    prev_options: row.prev_options ?? [],
    new_guest_name: row.new_guest_name,
    new_guest_phone: row.new_guest_phone,
    new_room_name: row.new_room_name,
    new_check_in: row.new_check_in,
    new_check_out: row.new_check_out,
    new_amount: row.new_amount,
    new_options: row.new_options ?? [],
    new_payment_method: row.new_payment_method,
    new_payment_status: row.new_payment_status,
    status: row.status,
    created_at: row.created_at,
  }));
}
```

Add `ReservationChange` to the existing `import type { Reservation, BlockTask } from './db-types';` line → `import type { Reservation, BlockTask, ReservationChange } from './db-types';`

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (기존 `tsconfig.json` strict.)

- [ ] **Step 4: Commit**

```bash
git add lib/db-types.ts lib/queries.ts
git commit -m "feat: ReservationChange 타입 + getPendingReservationChanges 조회"
```

---

## Task 7: `lib/actions.ts` — 두 server action

**Files:**
- Modify: `lib/actions.ts`

**Interfaces:**
- Consumes: `createClient` (`./supabase/server`), Task 5 RPC.
- Produces:
  ```ts
  export async function keepReservationChange(changeId: string): Promise<{ error: string | null }>;
  export async function confirmReservationChange(changeId: string): Promise<{ error: string | null }>;
  ```

- [ ] **Step 1: Append the two actions**

Append to `lib/actions.ts`:

```ts
// 예약 변경 확인 큐 — [기존 예약 유지]: 변경 메일 무시, 예약 원본 유지.
export async function keepReservationChange(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('keep_reservation_change', {
    p_change_id: changeId,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

// [변경 확정]: 예약을 새 값으로 교체(같은 id) + 옛 날짜 다시 열기 + 새 날짜 막기 + 재트리아지.
export async function confirmReservationChange(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_reservation_change', {
    p_change_id: changeId,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/actions.ts
git commit -m "feat: keepReservationChange / confirmReservationChange server actions"
```

---

## Task 8: `components/Badges.tsx` + `components/ReservationChangeQueue.tsx`

**Files:**
- Modify: `components/Badges.tsx` (add `ChangeRequestBadge`)
- Create: `components/ReservationChangeQueue.tsx`

**Interfaces:**
- Consumes: `ReservationChange` (`lib/db-types`), `refundForChange` (`lib/refund`), `changedFields`/`changeSummaryLabel` (`lib/reservation-change`), `formatWon`/`formatDateRange` (`lib/format`), `displayRoomName` (`lib/rooms`), `ChannelBadge` (`./Badges`).
- Produces:
  ```ts
  // Badges.tsx
  export function ChangeRequestBadge(): JSX.Element;
  // ReservationChangeQueue.tsx
  export function ReservationChangeQueue(props: {
    changes: ReservationChange[];
    onKeep: (changeId: string) => void;
    onConfirm: (changeId: string) => void;
    todayISO?: string;
    id?: string;
  }): JSX.Element;
  ```

- [ ] **Step 1: Add `ChangeRequestBadge` to `components/Badges.tsx`**

Append to `components/Badges.tsx`:

```tsx
// 원래 예약 카드에 "이 예약에 처리 대기 중인 변경 요청이 있음"을 알리는 배지.
export function ChangeRequestBadge() {
  return <span className="badge badge-change-request">변경 요청</span>;
}
```

- [ ] **Step 2: Create `components/ReservationChangeQueue.tsx`**

```tsx
'use client';

import type { ReservationChange } from '../lib/db-types';
import { ChannelBadge } from './Badges';
import { formatWon, formatDateRange } from '../lib/format';
import { displayRoomName } from '../lib/rooms';
import { refundForChange } from '../lib/refund';
import { changedFields, changeSummaryLabel } from '../lib/reservation-change';

// 예약 변경 확인 큐. 상태는 부모(DashboardRealtime)가 소유 — 이 컴포넌트는 순수 표시 +
// onKeep/onConfirm 콜백만. 변경 메일이 오면 예약 본체는 그대로이고 여기 pending 으로 뜬다.
// 직원이 [기존 예약 유지] 또는 [변경 확정]을 눌러야 반영된다.

export function ReservationChangeQueue({
  changes,
  onKeep,
  onConfirm,
  todayISO,
  id,
}: {
  changes: ReservationChange[];
  onKeep: (changeId: string) => void;
  onConfirm: (changeId: string) => void;
  todayISO?: string;
  id?: string;
}) {
  const pending = [...changes]
    .filter((c) => c.status === 'pending')
    .sort((a, b) => a.new_check_in.localeCompare(b.new_check_in));

  return (
    <section id={id}>
      <div className="section-title">
        <h2>예약 변경 확인</h2>
        <span className="count-pill">{pending.length}건</span>
      </div>

      {pending.length === 0 ? (
        <div className="empty">대기 중인 예약 변경 없음</div>
      ) : (
        pending.map((c) => {
          const fields = changedFields(
            {
              check_in: c.prev_check_in,
              check_out: c.prev_check_out,
              room_name: c.prev_room_name,
              amount: c.prev_amount,
              guest_name: c.prev_guest_name,
              options: c.prev_options,
            },
            {
              check_in: c.new_check_in,
              check_out: c.new_check_out,
              room_name: c.new_room_name,
              amount: c.new_amount,
              guest_name: c.new_guest_name,
              guest_phone: c.new_guest_phone,
              options: c.new_options,
            },
          );
          // 위약금 기준: 변경 전(직전) 체크인 · 직전 결제금액.
          const refund = refundForChange(c.prev_check_in, c.prev_amount, todayISO);

          return (
            <div key={c.id} className="card">
              <div className="badge-row">
                <ChannelBadge channel={c.reservation_channel} />
                <span className="card-title">
                  {c.new_guest_name ?? c.prev_guest_name ?? '이름 미상'}
                </span>
              </div>

              <div className="change-rows">
                <div className="change-row">
                  <span className="change-tag">기존</span>
                  {formatDateRange(c.prev_check_in, c.prev_check_out)} ·{' '}
                  {displayRoomName(c.prev_room_name)} · {formatWon(c.prev_amount)}
                </div>
                <div className="change-row change-row-new">
                  <span className="change-tag">변경</span>
                  {formatDateRange(c.new_check_in, c.new_check_out)} ·{' '}
                  {displayRoomName(c.new_room_name)} · {formatWon(c.new_amount)}{' '}
                  <em>({changeSummaryLabel(fields)})</em>
                </div>
              </div>

              <PenaltyBanner refund={refund} total={c.prev_amount} />

              <div className="badge-row">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onKeep(c.id)}
                >
                  기존 예약 유지
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => onConfirm(c.id)}
                >
                  변경 확정
                </button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

function PenaltyBanner({
  refund,
  total,
}: {
  refund: ReturnType<typeof refundForChange>;
  total: number | null;
}) {
  if (!refund.hasPenalty) {
    return (
      <div className="penalty-banner ok">
        ✓ 위약금 없음 (체크인 {refund.daysBefore}일 전)
      </div>
    );
  }
  if (!refund.amountKnown) {
    return (
      <div className="penalty-banner warn">
        ⚠️ 위약금 발생 구간 (체크인 {refund.daysBefore}일 전) · 금액 미상 — 위약금 수동 확인
      </div>
    );
  }
  if (refund.refundRate === 0) {
    return (
      <div className="penalty-banner danger">
        <strong>⚠️ 위약금 {formatWon(total)} (전액) · 환불 불가</strong>
        <div>체크인 {refund.daysBefore}일 이내 변경</div>
      </div>
    );
  }
  return (
    <div className="penalty-banner warn">
      <strong>⚠️ 위약금 {formatWon(refund.penalty)} 발생</strong>
      <div>
        체크인 {refund.daysBefore}일 전 변경 · 환불 가능 {formatWon(refund.refundable)} (
        {Math.round(refund.refundRate * 100)}%) · 총 결제 {formatWon(total)}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add minimal styles**

In `app/globals.css`, append:

```css
/* 예약 변경 확인 큐 */
.badge-change-request { background: var(--st-awaiting); color: #fff; }
.change-rows { margin: 8px 0; font-size: 13px; line-height: 1.7; }
.change-tag {
  display: inline-block; min-width: 34px; margin-right: 6px; padding: 0 6px;
  border-radius: 4px; background: var(--surface-2, #eee); font-size: 11px;
}
.change-row-new { font-weight: 600; }
.penalty-banner { margin: 8px 0; padding: 8px 10px; border-radius: 6px; font-size: 12px; }
.penalty-banner.ok { background: color-mix(in srgb, var(--st-confirmed) 12%, transparent); }
.penalty-banner.warn { background: color-mix(in srgb, var(--st-awaiting) 16%, transparent); }
.penalty-banner.danger { background: color-mix(in srgb, #d33 16%, transparent); }
.penalty-banner strong { display: block; margin-bottom: 2px; }
.btn-secondary {
  padding: 6px 12px; border: 1px solid var(--border, #ccc); border-radius: 6px;
  background: transparent; cursor: pointer; font-size: 13px;
}
```

> `app/globals.css` 에 이미 있는 변수명(`--st-confirmed`, `--st-awaiting`, `--border` 등)을 먼저 `grep` 으로 확인하고, 없는 변수는 fallback 값(위 `color-mix` / `var(x, fallback)`)으로 둔다. `.btn-primary` 는 이미 정의돼 있음.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/Badges.tsx components/ReservationChangeQueue.tsx app/globals.css
git commit -m "feat: ReservationChangeQueue 컴포넌트 + 위약금 배너 + 변경요청 배지"
```

---

## Task 9: `ReservationList` / `RoomCalendar` — "이전 …에서 변경" 줄 + "변경 요청" 배지

**Files:**
- Modify: `components/ReservationList.tsx`
- Modify: `components/RoomCalendar.tsx`

**Interfaces:**
- Consumes: `Reservation.prev_check_in/out` (Task 6), `ChangeRequestBadge` (Task 8), 새 prop `pendingChangeReservationIds: Set<string>`.
- Produces: 시각 변화만. 새 export 없음.

- [ ] **Step 1: `ReservationList` — prop 추가 + 배지 + 이전 날짜 줄**

In `components/ReservationList.tsx`:

1. import 에 `ChangeRequestBadge` 추가:
```ts
import { ChannelBadge, StatusBadge, ChangeRequestBadge } from './Badges';
```
2. `formatDateShort` 도 import (이전 날짜 표기용):
```ts
import { formatWon, formatDateRange, timeAgo, formatOptions, formatDateShort } from '../lib/format';
```
3. props 타입에 추가:
```ts
export function ReservationList({
  reservations,
  blockTasks,
  pendingChangeReservationIds,
  id,
}: {
  reservations: Reservation[];
  blockTasks: BlockTask[];
  pendingChangeReservationIds: Set<string>;
  id?: string;
}) {
```
4. 카드의 `card-meta` 안, `감지 {timeAgo(...)}` 줄 다음에 "이전 날짜" 줄 추가:
```tsx
                    감지 {timeAgo(r.detected_at)}
                    {pendingBlocks > 0 && ` · 막을 채널 ${pendingBlocks}곳 남음`}
                    {r.prev_check_in && r.prev_check_out && (
                      <>
                        <br />
                        <span className="prev-dates">
                          이전 {formatDateShort(r.prev_check_in)}~
                          {formatDateShort(r.prev_check_out)} 에서 변경
                        </span>
                      </>
                    )}
```
5. `badge-row` 에 배지 추가:
```tsx
              <div className="badge-row">
                <ChannelBadge channel={r.channel} />
                <StatusBadge status={r.status} />
                {pendingChangeReservationIds.has(r.id) && <ChangeRequestBadge />}
              </div>
```

- [ ] **Step 2: `RoomCalendar` — 이전 날짜 줄**

In `components/RoomCalendar.tsx`, near the existing `cal-notes-preview` render (line ~274), add — only where a full reservation object is in scope (same block that shows `reservation.notes`):

```tsx
                          {reservation.prev_check_in && reservation.prev_check_out && (
                            <span className="cal-prev-dates">
                              이전 {formatDateShort(reservation.prev_check_in)}~
                              {formatDateShort(reservation.prev_check_out)}
                            </span>
                          )}
```

Ensure `formatDateShort` is imported in `RoomCalendar.tsx` (add to its `lib/format` import if missing).

- [ ] **Step 3: Styles**

Append to `app/globals.css`:
```css
.prev-dates, .cal-prev-dates { color: var(--st-awaiting); font-size: 11px; }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors about `ReservationList` missing `pendingChangeReservationIds` at its call site in `DashboardRealtime.tsx` — that's fixed in Task 10. Everything else clean.

- [ ] **Step 5: Commit**

```bash
git add components/ReservationList.tsx components/RoomCalendar.tsx app/globals.css
git commit -m "feat: 예약 카드/달력에 '이전 날짜에서 변경' 표시 + 변경요청 배지"
```

---

## Task 10: `app/page.tsx` + `DashboardRealtime.tsx` — 배선

**Files:**
- Modify: `app/page.tsx`
- Modify: `components/DashboardRealtime.tsx`

**Interfaces:**
- Consumes: `getPendingReservationChanges` (Task 6), `keepReservationChange`/`confirmReservationChange` (Task 7), `ReservationChangeQueue` (Task 8), `ReservationChange` (Task 6).
- Produces: 완성된 대시보드 흐름.

- [ ] **Step 1: `app/page.tsx` — 큐 로드**

In `app/page.tsx`:
1. import 확장:
```ts
import {
  getReservations,
  getBlockTasks,
  getLastSyncByChannel,
  getPendingReservationChanges,
} from '../lib/queries';
```
2. `Promise.all` 확장:
```ts
  const [reservations, blockTasks, lastSync, pendingChanges] = await Promise.all([
    getReservations(supabase),
    getBlockTasks(supabase),
    getLastSyncByChannel(supabase),
    getPendingReservationChanges(supabase),
  ]);
```
3. prop 전달:
```tsx
      <DashboardRealtime
        initialReservations={reservations}
        initialBlockTasks={blockTasks}
        initialChanges={pendingChanges}
      />
```

- [ ] **Step 2: `DashboardRealtime.tsx` — state + 구독 + 핸들러 + 렌더**

In `components/DashboardRealtime.tsx`:

1. imports:
```ts
import { ReservationChangeQueue } from './ReservationChangeQueue';
import type { Reservation, BlockTask, ReservationChange } from '../lib/db-types';
import {
  toggleBlockTask,
  confirmDeposit,
  createManualBlock,
  cancelManualBlock,
  cancelReservation,
  updateReservationNotes,
  createManualReservation,
  keepReservationChange,
  confirmReservationChange,
} from '../lib/actions';
```

2. props + state:
```ts
export function DashboardRealtime({
  initialReservations,
  initialBlockTasks,
  initialChanges,
}: {
  initialReservations: Reservation[];
  initialBlockTasks: BlockTask[];
  initialChanges: ReservationChange[];
}) {
  const [reservations, setReservations] = useState(initialReservations);
  const [blockTasks, setBlockTasks] = useState(initialBlockTasks);
  const [changes, setChanges] = useState(initialChanges);
```

3. realtime: add a third `.on(...)` before `.subscribe(...)`:
```ts
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'reservation_changes' },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const oldId = (payload.old as { id: string }).id;
              setChanges((prev) => prev.filter((c) => c.id !== oldId));
              return;
            }
            const incoming = payload.new as Partial<ReservationChange> & {
              id: string;
              status: ReservationChange['status'];
              reservation_id: string;
            };
            // pending 이 아니게 되면(확정/유지/철회) 목록에서 제거.
            if (incoming.status !== 'pending') {
              setChanges((prev) => prev.filter((c) => c.id !== incoming.id));
              return;
            }
            // 원본 페이로드엔 reservations 조인이 없음 — 채널/notes 는 현재 예약 state 에서 보강.
            setChanges((prev) => {
              const res = reservations.find((r) => r.id === incoming.reservation_id);
              const existing = prev.find((c) => c.id === incoming.id);
              const merged = {
                reservation_channel: res?.channel ?? existing?.reservation_channel ?? 'naver',
                reservation_notes: res?.notes ?? existing?.reservation_notes ?? null,
                prev_options: [],
                new_options: [],
                ...existing,
                ...incoming,
              } as ReservationChange;
              const idx = prev.findIndex((c) => c.id === merged.id);
              if (idx === -1) return [merged, ...prev];
              const copy = [...prev];
              copy[idx] = merged;
              return copy;
            });
          },
        )
```
Note: add `reservations` to the `useEffect` dependency array is **not** wanted (it would re-subscribe on every change). Instead read `reservations` via a ref. Add near the top of the component:
```ts
  const reservationsRef = useRef(reservations);
  useEffect(() => { reservationsRef.current = reservations; }, [reservations]);
```
and in the handler use `reservationsRef.current.find(...)` instead of `reservations.find(...)`. Add `useRef` to the React import.

4. handlers (near `handleConfirmDeposit`):
```ts
  const handleKeepChange = (changeId: string) => {
    setChanges((prev) => prev.filter((c) => c.id !== changeId)); // 낙관적 제거
    startTransition(() => {
      keepReservationChange(changeId).then((res) => {
        if (res.error) console.error('변경 유지 실패:', res.error);
      });
    });
  };

  const handleConfirmChange = (changeId: string) => {
    setChanges((prev) => prev.filter((c) => c.id !== changeId));
    startTransition(() => {
      confirmReservationChange(changeId).then((res) => {
        if (res.error) console.error('변경 확정 실패:', res.error);
      });
    });
  };
```

5. derived + quick-nav + render. Add:
```ts
  const changeCount = changes.filter((c) => c.status === 'pending').length;
  const pendingChangeReservationIds = new Set(
    changes.filter((c) => c.status === 'pending').map((c) => c.reservation_id),
  );
```
In `<nav className="quick-nav">`, add as first item:
```tsx
        <a href="#changes">
          변경확인
          <span className={`n-count ${changeCount === 0 ? 'zero' : ''}`}>
            {changeCount}
          </span>
        </a>
```
Render `<ReservationChangeQueue>` right above `<DepositQueue ...>`:
```tsx
      <ReservationChangeQueue
        id="changes"
        changes={changes}
        onKeep={handleKeepChange}
        onConfirm={handleConfirmChange}
      />
      <DepositQueue id="deposit" reservations={reservations} onConfirm={handleConfirmDeposit} />
```
Pass the new prop to `<ReservationList>`:
```tsx
      <ReservationList
        id="list"
        reservations={reservations}
        blockTasks={blockTasks}
        pendingChangeReservationIds={pendingChangeReservationIds}
      />
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed. Fix any type mismatch (esp. the realtime merge cast).

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx components/DashboardRealtime.tsx
git commit -m "feat: 대시보드에 예약 변경 확인 큐 배선 + realtime 구독"
```

---

## Task 11: 통합 검증 (프리뷰 + 로컬 DB)

**Files:** none (verification only)

- [ ] **Step 1: 로컬 스택 기동**

Run:
```bash
supabase db reset
npm run dev
```
`.env.local` 이 로컬 supabase(`127.0.0.1:54321`)를 가리키는지 확인. 아니면 로컬용 값으로 임시 교체.

- [ ] **Step 2: 시드 데이터 주입**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select ingest_reservation('naver','SEED1','김손님','010-0','page26',
  current_date + 7, current_date + 8, 150000, '[]'::jsonb,'cash','pending',
  '{}'::jsonb, false);
select ingest_reservation('naver','SEED1','김손님','010-0','page26',
  current_date + 20, current_date + 21, 150000, '[]'::jsonb,'cash','pending',
  '{}'::jsonb, false);
"
```
(2번째 호출 = 날짜 변경 → pending 큐 1건, 위약금 구간: 체크인 7일 전 → 70% / 위약금 45,000.)

- [ ] **Step 3: 브라우저 검증 (preview 도구)**

- `preview_start` → 대시보드 로드.
- `read_page` 로 "예약 변경 확인" 섹션에 카드 1건, `기존 … ~ / 변경 … ~ (날짜 변경)`,
  배너 `⚠️ 위약금 ₩45,000 발생 … 70% …` 확인.
- 전체 예약 목록의 SEED1 카드에 `변경 요청` 배지 확인.
- `[변경 확정]` 버튼 클릭 → `read_page` 로 큐가 비고, 전체 예약 카드 날짜가 새 날짜로 바뀌고
  `이전 …에서 변경` 줄이 생기고 배지가 사라짐 확인.
- `막아야 할 채널` 섹션에 새 날짜 막기 태스크가 뜬 것 확인.
- `read_console_messages` 로 에러 없음 확인.

- [ ] **Step 4: 되돌림 케이스**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select ingest_reservation('naver','SEED2','박손님','010-2','page11',
  current_date + 30, current_date + 31, 200000, '[]'::jsonb,'cash','pending','{}'::jsonb,false);
select ingest_reservation('naver','SEED2','박손님','010-2','page11',
  current_date + 40, current_date + 41, 200000, '[]'::jsonb,'cash','pending','{}'::jsonb,false);
select ingest_reservation('naver','SEED2','박손님','010-2','page11',
  current_date + 30, current_date + 31, 200000, '[]'::jsonb,'cash','pending','{}'::jsonb,false);
"
```
`read_page` → SEED2 는 큐에 **없어야** 함(자동 철회). `psql -c "select status from reservation_changes rc join reservations r on r.id=rc.reservation_id where r.channel_reservation_id='SEED2';"` → `withdrawn`.

- [ ] **Step 5: 전체 테스트 + 최종 커밋**

Run:
```bash
TZ=UTC npx vitest run && npx tsc --noEmit && npm run build
```
Expected: 전부 통과.

```bash
git add -A
git commit -m "test: 예약 변경 확인 워크플로우 통합 검증 완료"
```

---

## Self-Review

**1. Spec coverage**

| 스펙 항목 | 담당 Task |
|---|---|
| §3 `reservation_changes` 테이블(withdrawn 포함) | Task 3 |
| §4 `reservations.prev_check_in/out` | Task 3 |
| §5 감지 분기(동일/취소/변경/원복 자동철회, payment 필드 제외) | Task 4 |
| §5 확정 후 되돌림 → 새 pending | Task 4 (C분기, prev=현재 예약값) |
| §6.1 `keep_reservation_change` | Task 5 |
| §6.2 `confirm_reservation_change` (in-place, notes 보존, 재트리아지, prev 기록) | Task 5 |
| §6.2 옛 날짜 다시 열기 + 새 날짜 막기 (동시 공존) | Task 3(unique 제거) + Task 5(6b/6c) |
| §7 `lib/refund.ts` 규정표·반올림·금액미상 | Task 1 |
| §8 `ReservationChangeQueue` + 위약금 배너 4분기 + 위약금액 굵게 | Task 8 |
| §8 "변경 요청" 배지 | Task 8(배지) + Task 9(표시) + Task 10(집합 전달) |
| §8 "이전 …에서 변경" 줄 (목록·달력) | Task 9 |
| §9 `db-types`/`queries`/`actions`/`page`/`DashboardRealtime` 배선 | Task 6·7·10 |
| §10 테스트(refund 경계, 감지 분기) | Task 1·2(순수) + Task 4·5(SQL 시나리오) |
| §11 마이그레이션 단일 파일 `0023` | Task 3·4·5 |
| §12 범위 밖(달력 취소엔 위약금 미적용 등) | 반영(건드리지 않음) |

빠진 항목 없음. 단, 스펙 §5 는 "pending 있는데 또 변경 → prev_* 유지"라고만 했고 "prev_* 는 최초 진입값 고정"으로 Task 3/4 에서 구체화함(문서 §3 주석과 일치).

**2. Placeholder scan**

플랜 내 `TBD`/`TODO`/"적절히 처리"/"위와 유사" 없음. 모든 코드 스텝에 실제 코드 포함. `app/globals.css` 변수 확인 단계는 "grep 으로 확인 후 fallback" 이라는 구체 지시로 대체함.

**3. Type consistency**

- `refundForChange(baseCheckIn, totalAmount, todayISO?)` — Task 1 정의, Task 8 에서 `refundForChange(c.prev_check_in, c.prev_amount, todayISO)` 호출. 일치.
- `RefundInfo` 필드(`daysBefore/refundRate/refundable/penalty/hasPenalty/amountKnown`) — Task 1 정의, Task 8 `PenaltyBanner` 에서 사용. 일치.
- `changedFields(prev, next)` / `changeSummaryLabel(fields)` / `ChangeSnapshot` — Task 2 정의, Task 8 사용. `ChangeSnapshot.guest_phone?` optional — Task 8 은 next 에만 전달, prev 는 생략(=undefined) → 규칙상 `next.guest_phone != null` 만 보므로 안전.
- `ReservationChange` 필드 — Task 6 정의(=`db-types`), Task 6 `queries`, Task 8 컴포넌트, Task 10 realtime 머지에서 사용. 필드명 일치(`reservation_channel`, `new_check_in`, `prev_amount` 등).
- `keep_reservation_change` / `confirm_reservation_change` RPC 파라미터 `p_change_id` — Task 5 정의, Task 7 액션에서 `{ p_change_id: changeId }`. 일치.
- `getPendingReservationChanges` — Task 6 정의, Task 10 `app/page.tsx` 사용. 일치.
- `ReservationChangeQueue` props(`changes/onKeep/onConfirm/todayISO?/id?`) — Task 8 정의, Task 10 렌더. 일치.
- `ReservationList` 새 prop `pendingChangeReservationIds: Set<string>` — Task 9 정의, Task 10 전달. 일치.
- SQL: `ingest_reservation` 시그니처(13 파라미터) — Task 4 재정의가 0014 와 동일, `revoke/grant` 시그니처도 동일. `block_tasks` 제약명 `block_tasks_reservation_id_target_channel_key` — Postgres 기본 명명 규칙(`<table>_<col>_<col>_key`) 확인 필요: Task 3 Step 2 의 `select conname ...` 로 실제 이름을 먼저 확인하고 다르면 그 이름으로 `drop constraint` 수정.

이슈 없음(위 `block_tasks` 제약명 확인은 Task 3 Step 2 에 이미 포함).
