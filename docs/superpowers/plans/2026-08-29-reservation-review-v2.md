# 예약 확인 큐 v2 (변경 + 취소 + 되살리기 + 손님 요청사항) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** v1("예약 변경 확인 큐")를 확장 — 취소·되살리기도 같은 큐에서 직원이 확정하게 하고, 손님 요청사항을 직원 메모와 분리해 표시한다.

**Architecture:** 기존 `feat/reservation-change-review` 브랜치(v1) 위에 얹는다. `reservation_changes` 테이블에 `kind`(`change`|`cancel`|`uncancel`)를 추가해 한 큐가 3종을 담고, `ingest_reservation` 이 종류별로 pending 행을 만든다. 취소는 즉시 반영하지 않고 `[취소 확정]` 을 눌러야 반영된다. 스테이폴리오 ICS 누락 자동취소도 큐로 우회한다. 파서가 `guest_request` 를 뽑아 `reservations.guest_request` 로 저장하고 읽기전용으로 표시한다.

**Tech Stack:** Next.js 15.3 (App Router, RSC + server actions), Supabase(Postgres + Realtime), TypeScript, vitest(`TZ=UTC vitest run`).

## 시작 지점 (중요)

- 브랜치 `feat/reservation-change-review` HEAD = `918d61d` (v1 구현 + 최종리뷰 반영 + 설계 v2 문서까지 커밋됨).
- v1 산출물이 이미 존재한다 — 이 계획은 **대부분 기존 파일 수정**이다:
  - `lib/refund.ts` (+test), `lib/reservation-change.ts` (+test) — 존재, 소폭 수정
  - `supabase/migrations/0023_reservation_change_review.sql` — 존재, **이 파일을 직접 편집한다**(아직 어느 DB에도 적용 안 됨 → 마이그레이션 하나로 유지)
  - `scripts/verify-0023.sql` — 존재, 시나리오 추가
  - `lib/db-types.ts`, `lib/queries.ts`, `lib/actions.ts` — 존재, 필드/함수 추가
  - `components/ReservationChangeQueue.tsx`, `components/Badges.tsx`, `components/ReservationList.tsx`, `components/RoomCalendar.tsx`, `components/DashboardRealtime.tsx`, `app/page.tsx` — 존재, 수정
  - `app/globals.css` — 존재, 규칙 추가
- 설계 근거: `docs/superpowers/specs/2026-08-28-reservation-change-review-design.md` 의 **"개정 v2" 절**(§V2-0 ~ §V2-9). v1 본문과 상충 시 v2 우선.

## Global Constraints

- 날짜 문자열(`'YYYY-MM-DD'`) 계산은 **반드시** `new Date(iso + 'T00:00:00Z')` + `getUTC*` 만. `kstTodayISO()` 로 "오늘"(KST). (섞으면 Vercel UTC 오프바이원 → OOM 장애 재발.)
- DB 함수 권한: `ingest_reservation`(security definer, 워커 전용) 은 `revoke all ... from public` + `grant execute ... to service_role`, 시그니처는 **현재 `0023` 파일의 것과 파라미터 목록 동일**(아래 §Task 5 에서 `guest_request` 1개 추가 → revoke/grant 인자 목록도 함께 갱신). 대시보드 RPC 는 `security invoker` + `grant execute ... to authenticated`.
- 감사: `reservation_events` append-only. 시스템 `actor=null`, 직원 `actor=auth.uid()`.
- `reservation_changes` 부분 유니크 `(reservation_id) where status='pending'` 유지 — 한 예약에 열린 확인 건은 항상 1개. 취소가 변경보다 우선(변경 대기 중 취소 신호 → 그 행을 `kind='cancel'` 로 갈아끼움).
- `change` 큐 트리거 = **날짜(check_in/out) · 객실(room_name) · 옵션(options)** 만. `guest_name`/`guest_phone`/`amount`/`payment_*` 단독 변경은 예약 본체 즉시 갱신 + `updated` 이벤트만, 큐 안 탐.
- `guest_request` 는 `change` 트리거 **아님**. 재수신 시 조용히 갱신. `reservations.notes`(직원 메모)와 **절대 섞지 않는다**.
- 게스트하우스 판별(그대로): `room_name like '객실 서쪽%'|'객실 남쪽%'|'서쪽방%'|'남쪽방%'` → 이 경우 `stayfolio` block_task 생성 안 함. NULL 안전하게 `coalesce(..., false)`.
- 달력의 수동 취소 토글(`staff_cancel_reservation`)은 **즉시 취소 유지** — 직원이 직접 누른 것이라 게이트 불필요. 이번 변경 대상 아님.
- 위약금: `lib/refund.ts` 순수함수 재사용. `change` 카드 = 직전 체크인 기준(v1), `cancel` 카드 = **현재 예약 체크인** 기준.
- 실제 환불/PG 연동 없음 — 위약금은 표시만.
- DB 실행 불가 환경 대비: `0023` / `verify-0023.sql` 는 **작성 + 정적 리뷰만**. 적용·시나리오 실행은 사용자가 비운영 Supabase 에서. tsc / vitest / `npm run build` 는 반드시 통과.

---

## File Structure

| 파일 | v2 에서의 책임 | 작업 |
|------|------|------|
| `lib/types.ts` | `ParsedReservation.guest_request` | Modify (T1) |
| `lib/parsers/naver.ts`, `lib/parsers/stayfolio-email.ts` (+ .test) | `요청사항` → `guest_request` 추출 | Modify (T1) |
| `lib/refund.ts` (+test) | `refundFor` alias (cancel 카드 = 현재 체크인 기준 호출용) | Modify (T2) |
| `lib/reservation-change.ts` (+test) | `changedFields` 를 `'dates'\|'room'\|'options'` 로 축소 | Modify (T3) |
| `supabase/migrations/0023_reservation_change_review.sql` | `kind`/`cancel_*`/`guest_request` 컬럼, `ingest_reservation` v2 분기, kind별 확정 RPC, reconcile용 enqueue 함수 | Modify (T4·T5·T6·T7) |
| `scripts/verify-0023.sql` | v2 시나리오 | Modify (T8) |
| `lib/db-types.ts`, `lib/queries.ts` | `ReservationChange`/`Reservation` 필드 추가 | Modify (T9) |
| `lib/actions.ts` | `confirmCancelReview`, `confirmUncancelReview` | Modify (T10) |
| `lib/mail/reconcile-stayfolio-ics.ts`, `lib/ingest.ts` | reconcile → enqueue RPC 호출, ingest 가 `guest_request` 전달 | Modify (T11) |
| `components/Badges.tsx` | `CancelRequestBadge`, `UncancelRequestBadge` | Modify (T12) |
| `components/ReservationChangeQueue.tsx` | kind별 카드/버튼 | Modify (T12) |
| `components/ReservationList.tsx`, `components/RoomCalendar.tsx` | `손님 요청` 줄 + kind별 배지 | Modify (T13) |
| `app/page.tsx`, `components/DashboardRealtime.tsx`, `app/globals.css` | kind별 배지 집합, `guest_request` 전달, quick-nav 문구 | Modify (T14) |

---

## Task 1: 파서 — `guest_request` 추출

**Files:**
- Modify: `lib/types.ts` (`ParsedReservation`)
- Modify: `lib/parsers/naver.ts`, `lib/parsers/stayfolio-email.ts`
- Modify/Test: `lib/parsers/naver.test.ts`, `lib/parsers/stayfolio-email.test.ts`

**Interfaces:**
- Produces: `ParsedReservation.guest_request: string | null` — 손님이 남긴 요청사항. "없음"류/빈값은 `null`.

- [ ] **Step 1: `lib/types.ts` 에 필드 추가**

`ParsedReservation` 인터페이스에 `raw_payload` 바로 위:
```ts
  /** 손님이 채널에 남긴 요청사항. 없으면 null. 직원 메모(notes)와 별개. */
  guest_request: string | null;
```

- [ ] **Step 2: 공용 정규화 헬퍼**

`lib/parsers/util.ts` 끝에:
```ts
/** '요청사항' 원문 → 실제 내용만. "요청사항이 없습니다.", "-", "없음", 빈값 → null. */
export function normalizeGuestRequest(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^(-+|없음|요청사항이 없습니다\.?)$/.test(s)) return null;
  return s;
}
```

- [ ] **Step 3: 실패하는 테스트 추가**

`lib/parsers/naver.test.ts` — 기존 접수 `SAMPLE` 은 `요청사항 -` 이므로 null 이어야 하고, 요청사항이 있는 변형을 하나 추가:
```ts
it('요청사항 "-" 는 guest_request null', () => {
  expect(parseNaverEmail(SAMPLE)!.guest_request).toBeNull();
});
it('요청사항 내용이 있으면 그대로 담는다', () => {
  const withReq = SAMPLE.replace('요청사항 -', '요청사항 늦은 체크인 부탁드립니다 (오후 9시)');
  expect(parseNaverEmail(withReq)!.guest_request).toBe('늦은 체크인 부탁드립니다 (오후 9시)');
});
```
`lib/parsers/stayfolio-email.test.ts` — 유사하게 "요청사항이 없습니다." → null, 내용 있으면 담기는 케이스 1개씩. (기존 샘플 문자열에서 `요청사항` 토막을 replace.)

- [ ] **Step 4: 테스트 실행 → 실패 확인**

Run: `TZ=UTC npx vitest run lib/parsers/naver.test.ts lib/parsers/stayfolio-email.test.ts`
Expected: 새 테스트가 `guest_request` undefined 로 FAIL.

- [ ] **Step 5: 파서 구현**

`lib/parsers/naver.ts`:
- import 에 `normalizeGuestRequest` 추가 (`from './util'`).
- `LABELS` 에 이미 `'요청사항'` 있음(확인). return 객체에 `raw_payload` 바로 위:
  ```ts
    guest_request: normalizeGuestRequest(f['요청사항']),
  ```

`lib/parsers/stayfolio-email.ts`:
- `LABELS` 에 `'요청사항'` 이미 있음(확인). import + return 에 동일하게:
  ```ts
    guest_request: normalizeGuestRequest(f['요청사항']),
  ```
  (이 파서의 return 위치/필드 조립부에 맞춰 삽입. `raw_payload` 근처.)

- [ ] **Step 6: 다른 파서·호출부의 타입 구멍 메우기**

`ParsedReservation` 을 만드는 다른 곳(`lib/parsers/stayfolio-email-enrich.ts`, 수동/합성 경로 등)에서 `guest_request` 누락으로 tsc 가 깨질 수 있다. 각 생성 지점에 `guest_request: null` (또는 원본 파싱값 전달) 추가. `npx tsc --noEmit` 로 전부 확인.

- [ ] **Step 7: 테스트 + 타입체크**

Run: `TZ=UTC npx vitest run && npx tsc --noEmit`
Expected: 전부 통과.

- [ ] **Step 8: Commit**

```bash
git add lib/types.ts lib/parsers
git commit -m "feat: 파서가 손님 요청사항(guest_request) 추출 — 직원 메모와 분리"
```

---

## Task 2: `lib/refund.ts` — cancel 카드용 진입점

**Files:** Modify: `lib/refund.ts`, `lib/refund.test.ts`

**Interfaces:**
- Produces: `export const refundFor = refundForChange;` — 이름만 다른 alias. `cancel` 카드는 `refundFor(reservation.check_in, reservation.amount, todayISO)` 로 호출(현재 체크인 기준).

- [ ] **Step 1: alias + 테스트**

`lib/refund.ts` 파일 끝:
```ts
// 위약금 계산은 "어떤 체크인까지 며칠 남았나" 하나로 동일하다. change 카드는 직전 체크인,
// cancel 카드는 현재 예약 체크인을 넘겨 쓴다 — 의미를 드러내려고 이름만 따로 둔다.
export const refundFor = refundForChange;
```
`lib/refund.test.ts` 에 1줄:
```ts
it('refundFor 는 refundForChange 의 별칭', () => {
  expect(refundFor('2026-03-17', 150000, '2026-03-10')).toEqual(
    refundForChange('2026-03-17', 150000, '2026-03-10'),
  );
});
```
(v1 리뷰 Minor — `refundForChange` 가 `refundRateForDaysBefore` 와 사다리를 이중 계산하는 건 이번에 건드리지 않음. YAGNI.)

- [ ] **Step 2: 테스트**

Run: `TZ=UTC npx vitest run lib/refund.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/refund.ts lib/refund.test.ts
git commit -m "feat: refundFor alias — cancel 카드는 현재 체크인 기준으로 호출"
```

---

## Task 3: `lib/reservation-change.ts` — `changedFields` 축소

**Files:** Modify: `lib/reservation-change.ts`, `lib/reservation-change.test.ts`

**Interfaces:**
- Produces: `changedFields(prev, next): ChangedField[]` 에서 `ChangedField = 'dates' | 'room' | 'options'` (— `'amount'`, `'guest'` 제거). `changeSummaryLabel` 도 3종만. DB `v_changed`(§Task 5) 와 정확히 일치.

- [ ] **Step 1: 테스트 수정(먼저)**

`lib/reservation-change.test.ts`:
- `ChangeSnapshot` 에서 `amount`/`guest_name`/`guest_phone` 필드는 타입에 남겨도 되지만(호출부 편의) `changedFields` 결과에는 안 나와야 함. 테스트 갱신:
  - "금액만 다르면 빈 배열" — `changedFields(base, { ...base, amount: 120000 })` → `[]`
  - "예약자만 다르면 빈 배열" — `changedFields(base, { ...base, guest_name: '김철수' })` → `[]`
  - 날짜/객실/옵션 케이스는 그대로 유지, 복합은 `['dates','room','options']` 순서 확인
  - `changeSummaryLabel(['dates','options'])` → `'날짜·옵션 변경'`

- [ ] **Step 2: 실행 → 실패 확인**

Run: `TZ=UTC npx vitest run lib/reservation-change.test.ts` → 금액/예약자 케이스 FAIL.

- [ ] **Step 3: 구현 수정**

`lib/reservation-change.ts`:
```ts
export type ChangedField = 'dates' | 'room' | 'options';

// ChangeSnapshot 은 그대로 두되(amount/guest_name/guest_phone 는 호출부가 넘겨도 무시),
// 판정은 날짜·객실·옵션만. DB ingest_reservation v_changed(kind='change') 와 동일 범위.
const ORDER: ChangedField[] = ['dates', 'room', 'options'];
const LABEL: Record<ChangedField, string> = { dates: '날짜', room: '객실', options: '옵션' };

export function changedFields(prev: ChangeSnapshot, next: ChangeSnapshot): ChangedField[] {
  const set = new Set<ChangedField>();
  if (prev.check_in !== next.check_in || prev.check_out !== next.check_out) set.add('dates');
  if (prev.room_name !== next.room_name) set.add('room');
  const nextOpts = next.options ?? [];
  if (nextOpts.length > 0 && normOptions(prev.options) !== normOptions(nextOpts)) set.add('options');
  return ORDER.filter((f) => set.has(f));
}
```
`changeSummaryLabel` 은 그대로(빈 배열 → `'변경 없음'`). `amount`/`guest` 분기 삭제.
파일 상단 주석의 U+200C(제로폭) 오타도 이참에 제거.

- [ ] **Step 4: 테스트 + 타입체크**

Run: `TZ=UTC npx vitest run && npx tsc --noEmit`
Expected: PASS. (`ReservationChangeQueue.tsx` 가 `changedFields` 를 쓰지만 결과 타입이 좁아질 뿐이라 tsc OK. 만약 `'amount'`/`'guest'` 리터럴을 참조하면 T12 에서 정리.)

- [ ] **Step 5: Commit**

```bash
git add lib/reservation-change.ts lib/reservation-change.test.ts
git commit -m "refactor: changedFields 를 날짜·객실·옵션으로 축소 (v2 change 트리거와 일치)"
```

---

## Task 4: `0023` — 스키마 델타 (`kind`, `cancel_*`, `guest_request`)

**Files:** Modify: `supabase/migrations/0023_reservation_change_review.sql`

**환경:** DB 실행 불가. 편집 + 정적 리뷰만. `0023` 을 어느 DB에도 안 돌렸으므로 이 파일을 직접 고친다.

**Interfaces:**
- Produces:
  - `reservation_changes.kind text not null default 'change' check (kind in ('change','cancel','uncancel'))`
  - `reservation_changes.cancel_reason text`, `reservation_changes.cancel_source text`
  - `reservations.guest_request text`

- [ ] **Step 1: `reservation_changes` CREATE TABLE 수정**

`0023` §1 `create table reservation_changes (...)` 안, `status` 컬럼 정의 바로 위에 추가:
```sql
  kind          text not null default 'change'
                check (kind in ('change','cancel','uncancel')),
  cancel_reason text,        -- kind='cancel': 채널이 준 사유(네이버 취소사유 등). 없으면 null.
  cancel_source text,        -- kind='cancel': 'channel_notification' | 'stayfolio_ics_missing'
```
`reservation_changes_status_idx` 를 `(status, kind, new_check_in)` 로 확장.

- [ ] **Step 2: `reservations` 컬럼**

`0023` §2 (`alter table reservations add column prev_check_in ...`) 바로 아래에:
```sql
alter table reservations add column guest_request text;  -- 손님 요청사항(파서가 채움). notes(직원)와 별개.
```

- [ ] **Step 3: 정적 확인**

파일 전체 재읽기 — `$$` 균형, 섹션 순서, `check` 표현식 오타 없음. `npx tsc --noEmit`(스키마와 무관하지만 습관).

- [ ] **Step 4: Commit** (T5·T6·T7 과 같은 파일이므로 T7 끝에 한 번에 커밋해도 됨. 개별 커밋 원하면:)

```bash
git add supabase/migrations/0023_reservation_change_review.sql
git commit -m "feat: 0023 스키마 델타 — reservation_changes.kind/cancel_*, reservations.guest_request"
```

---

## Task 5: `0023` — `ingest_reservation` v2 분기

**Files:** Modify: `supabase/migrations/0023_reservation_change_review.sql` (§4 함수 본문)

**Interfaces:**
- Consumes: T4 컬럼들.
- Produces: `ingest_reservation(...)` — 파라미터에 **`p_guest_request text default null` 1개 추가**(마지막, `p_cancelled` 뒤). revoke/grant 인자 목록도 갱신. 동작:
  - **신규**(기존행 없음): v1 그대로 + `guest_request` insert.
  - **활성 예약(status <> 'cancelled') 재수신**:
    - `guest_request` 는 항상 갱신(큐 트리거 아님).
    - `payment_method`/`payment_status`/`raw_payload` 는 v1 그대로 항상 갱신.
    - `p_cancelled = true` → `reservation_changes` 에 `kind='cancel'` pending upsert(`cancel_reason`=`p_room... 없음`; 파서가 준 사유가 없으면 null, 있으면… ingest 시그니처엔 사유 인자 없음 → §참고), `cancel_source='channel_notification'`. **예약 status 는 안 바꿈.** `updated` 대신 `note` 이벤트 `{source:'cancel_review_queued'}`. 이미 pending 이 `kind='change'` 면 `kind='cancel'` 로 갈아끼움(취소 우선).
    - `p_cancelled = false` & (check_in/out **or** room_name **or** options) 변경 → `kind='change'` pending upsert (v1 로직). 이미 pending 이 `kind='cancel'` 이면 **건드리지 않음**(취소 검토가 우선; 변경분은 무시하고 `note` 만).
    - 그 외(값 동일, 또는 guest/amount 만 변경) → 예약 즉시 갱신(guest_name/phone/amount 포함) + `updated` 이벤트(실제 바뀐 게 있을 때만). pending `kind='change'` 가 있고 이번 값이 원복이면 `withdrawn`(v1). pending `kind='cancel'` 이 있는데 이번이 **정상 접수 재수신**(값이 기존과 동일 or 정상 예약 필드) 이면 → `withdrawn` + `note` "손님이 취소 철회".
  - **취소된 예약(status = 'cancelled') 재수신**:
    - `p_cancelled = true` → 멱등(무시, `raw_payload`만).
    - `p_cancelled = false` (정상 접수 메일 = 되살리기 신호) → `reservation_changes` 에 `kind='uncancel'` pending upsert (`prev_*` = 현재 취소된 예약 스냅샷, `new_*` = 들어온 값). `note` 이벤트 `{source:'uncancel_review_queued'}`. 예약 status 는 `cancelled` 유지.
    - `guest_request` 는 갱신.

> **`cancel_reason` 채우기:** `ingest_reservation` 시그니처에 사유 인자를 새로 넣지 않는다(호출부 파급 큼). 대신 **파서가 `raw_payload` 에 이미 사유를 담고 있으므로**, `kind='cancel'` 행의 `cancel_reason` 은 `p_raw->'fields'->>'취소사유'`(네이버) 또는 `p_raw->>'cancel_reason'` 등에서 뽑아 `coalesce` 로 채운다. 구체 경로는 파서별 `raw_payload` 구조 확인 후 결정(네이버: `raw_payload.fields['취소사유']`). 못 뽑으면 null.

- [ ] **Step 1: 함수 재작성**

`0023` §4 `create or replace function ingest_reservation(...)` 를 아래 구조로 교체. 현재 파일의 branch A(신규)/기존 코드를 최대한 보존하고 branch B/C 를 위 규칙으로 재구성.

```sql
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
  p_cancelled              boolean default false,
  p_guest_request          text default null
) returns uuid
language plpgsql
security definer
as $$
declare
  v_id            uuid;
  v_exists        boolean;
  v_existing      reservations%rowtype;
  v_status        reservation_status;
  v_is_guesthouse boolean;
  v_opts          jsonb := coalesce(p_options, '[]'::jsonb);
  v_changed       boolean;   -- 날짜/객실/옵션 중 하나라도
  v_cancel_reason text := nullif(btrim(coalesce(p_raw->'fields'->>'취소사유','')), '');
  v_pending_kind  text;
begin
  v_status := case
    when p_payment_status = 'paid' then 'confirmed'
    when p_payment_status = 'pending' then 'awaiting_deposit'
    else 'new'
  end::reservation_status;

  v_is_guesthouse := coalesce(
    p_room_name like '객실 서쪽%' or p_room_name like '객실 남쪽%'
    or p_room_name like '서쪽방%' or p_room_name like '남쪽방%', false);

  select * into v_existing
    from reservations
   where channel = p_channel and channel_reservation_id = p_channel_reservation_id;
  v_exists := found;

  -- ── A) 신규 예약 ── (v1 그대로 + guest_request)
  if not v_exists then
    insert into reservations (
      channel, channel_reservation_id, guest_name, guest_phone, room_name,
      check_in, check_out, amount, options, payment_method, payment_status, status,
      cancelled_at, raw_payload, guest_request
    ) values (
      p_channel, p_channel_reservation_id, p_guest_name, p_guest_phone, p_room_name,
      p_check_in, p_check_out, p_amount, v_opts, p_payment_method, p_payment_status,
      case when p_cancelled then 'cancelled' else v_status end::reservation_status,
      case when p_cancelled then now() end, p_raw, p_guest_request
    ) returning id into v_id;

    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'detected',
              jsonb_build_object('channel', p_channel, 'payment_status', p_payment_status,
                                 'cancelled_on_arrival', p_cancelled));
    if not p_cancelled then
      insert into block_tasks (reservation_id, target_channel, check_in, check_out)
        select v_id, c, p_check_in, p_check_out
        from unnest(enum_range(null::channel)) as c
        where c <> p_channel and not (v_is_guesthouse and c = 'stayfolio'::channel);
    end if;
    return v_id;
  end if;

  v_id := v_existing.id;

  -- 원문·결제·요청사항은 어느 경로든 항상 최신화(큐 트리거 아님).
  update reservations
     set raw_payload    = p_raw,
         payment_method = p_payment_method,
         payment_status = p_payment_status,
         guest_request  = p_guest_request
   where id = v_id;

  select kind into v_pending_kind
    from reservation_changes where reservation_id = v_id and status = 'pending';

  -- ── B) 이미 취소된 예약 재수신 ──
  if v_existing.status = 'cancelled' then
    if p_cancelled then
      return v_id;                       -- 멱등
    end if;
    -- 정상 접수 메일 = 되살리기 신호 → uncancel 큐
    insert into reservation_changes (
      reservation_id, kind,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id, 'uncancel',
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options,'[]'::jsonb),
      p_guest_name, p_guest_phone, p_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set kind='uncancel',
      new_check_in=excluded.new_check_in, new_check_out=excluded.new_check_out,
      new_room_name=excluded.new_room_name, new_amount=excluded.new_amount,
      new_options=excluded.new_options, new_guest_name=excluded.new_guest_name,
      new_guest_phone=excluded.new_guest_phone, new_payment_method=excluded.new_payment_method,
      new_payment_status=excluded.new_payment_status, new_raw_payload=excluded.new_raw_payload;
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'note', jsonb_build_object('source','uncancel_review_queued'));
    return v_id;
  end if;

  -- ── C) 활성 예약 재수신 ──
  if p_cancelled then
    -- 취소 신호 → cancel 큐 (예약 status 는 안 바꿈). 취소가 변경보다 우선.
    insert into reservation_changes (
      reservation_id, kind, cancel_reason, cancel_source,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id, 'cancel', v_cancel_reason, 'channel_notification',
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options,'[]'::jsonb),
      p_guest_name, p_guest_phone, p_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set kind='cancel', cancel_reason=coalesce(excluded.cancel_reason, reservation_changes.cancel_reason),
      cancel_source='channel_notification',
      new_raw_payload=excluded.new_raw_payload;
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'note', jsonb_build_object('source','cancel_review_queued','reason', v_cancel_reason));
    return v_id;
  end if;

  v_changed :=
       p_check_in  is distinct from v_existing.check_in
    or p_check_out is distinct from v_existing.check_out
    or (p_room_name is not null and p_room_name is distinct from v_existing.room_name)
    or (v_opts <> '[]'::jsonb and v_opts is distinct from coalesce(v_existing.options,'[]'::jsonb));

  if v_changed then
    if v_pending_kind = 'cancel' then
      -- 취소 검토가 우선 — 변경분은 큐에 안 넣고 흔적만.
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note', jsonb_build_object('source','change_ignored_cancel_pending'));
      return v_id;
    end if;
    insert into reservation_changes (
      reservation_id, kind,
      prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
      new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
      new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
    ) values (
      v_id, 'change',
      v_existing.check_in, v_existing.check_out, v_existing.room_name,
      v_existing.amount, v_existing.guest_name, coalesce(v_existing.options,'[]'::jsonb),
      p_guest_name, p_guest_phone, p_room_name, p_check_in, p_check_out,
      p_amount, v_opts, p_payment_method, p_payment_status, p_raw
    )
    on conflict (reservation_id) where status = 'pending'
    do update set
      new_check_in=excluded.new_check_in, new_check_out=excluded.new_check_out,
      new_room_name=excluded.new_room_name, new_amount=excluded.new_amount,
      new_options=excluded.new_options, new_guest_name=excluded.new_guest_name,
      new_guest_phone=excluded.new_guest_phone, new_payment_method=excluded.new_payment_method,
      new_payment_status=excluded.new_payment_status, new_raw_payload=excluded.new_raw_payload;
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'updated', jsonb_build_object('source','channel_notification',
        'from', jsonb_build_object('check_in',v_existing.check_in,'check_out',v_existing.check_out,'room_name',v_existing.room_name),
        'to',   jsonb_build_object('check_in',p_check_in,'check_out',p_check_out,'room_name',p_room_name)));
    return v_id;
  end if;

  -- 값 동일(날짜/객실/옵션): guest/amount 는 위에서 이미 raw/pay 만 갱신했으니 여기서 본체도 맞춤
  update reservations set
    guest_name = p_guest_name,
    guest_phone = coalesce(p_guest_phone, guest_phone),
    amount = coalesce(p_amount, amount)
  where id = v_id
    and (guest_name is distinct from p_guest_name
      or (p_guest_phone is not null and guest_phone is distinct from p_guest_phone)
      or (p_amount is not null and amount is distinct from p_amount));
  if found then
    insert into reservation_events (reservation_id, actor, type, detail)
      values (v_id, null, 'updated', jsonb_build_object('source','channel_notification','fields','guest_or_amount'));
  end if;

  -- 대기 건 자동 철회
  if v_pending_kind = 'change' then
    update reservation_changes set status='withdrawn', resolved_at=now()
     where reservation_id = v_id and status='pending';
    if found then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note', jsonb_build_object('note','손님이 원래 예약 내용으로 되돌림 — 변경 요청 자동 철회'));
    end if;
  elsif v_pending_kind = 'cancel' then
    update reservation_changes set status='withdrawn', resolved_at=now()
     where reservation_id = v_id and status='pending';
    if found then
      insert into reservation_events (reservation_id, actor, type, detail)
        values (v_id, null, 'note', jsonb_build_object('note','정상 접수 메일 재수신 — 취소 요청 자동 철회(손님이 취소 철회)'));
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean, text
) from public;
grant execute on function ingest_reservation(
  channel, text, text, text, text, date, date, integer, jsonb,
  payment_method, payment_status, jsonb, boolean, text
) to service_role;
```

> 주의: 위 코드에서 `v1` 대비 없어진 것 — 취소 메일이 **즉시** `status='cancelled'` 로 만들던 branch B. 이제 취소는 무조건 큐. `staff_cancel_reservation`(달력 토글)만 즉시 취소로 남는다. 또한 이 함수는 더 이상 활성→취소 시 block_tasks 를 건드리지 않는다(그건 `confirm_cancel_review` 로 이동, §Task 6).

- [ ] **Step 2: 정적 리뷰**

`$$` 균형; 모든 `on conflict (reservation_id) where status='pending'` 이 부분 유니크 predicate 와 일치; `found` 은 각 문장 직후에만 읽음; 신규 경로가 v1 과 동치; revoke/grant 인자 목록에 `text` 추가됨.

- [ ] **Step 3: Commit** (T6·T7 과 묶어도 됨)

```bash
git add supabase/migrations/0023_reservation_change_review.sql
git commit -m "feat: 0023 ingest v2 — 취소/되살리기도 큐로, change 트리거 축소, guest_request"
```

---

## Task 6: `0023` — kind별 확정 RPC

**Files:** Modify: `supabase/migrations/0023_reservation_change_review.sql` (§5·§6 확장)

**Interfaces:**
- `keep_reservation_change(p_change_id uuid)` — v1 그대로, kind 무관. `status='kept'` + `note`. (이름 유지 — 프론트도 `keepReservationChange` 하나로 공용.)
- `confirm_reservation_change(p_change_id uuid)` — **kind='change' 전용**으로 가드 추가(`and kind='change'`). 나머지는 v1 §6 그대로(원자적 claim, in-place 갱신, 옛/새 block 재조정).
- 신규 `confirm_cancel_review(p_change_id uuid)` — kind='cancel'. 원자적 claim → `reservations.status='cancelled'`, `cancelled_at`, `cancelled_by=auth.uid()` → block_tasks: pending/block→skipped, done/block→pending/unblock → `cancelled` 이벤트 `{source:'cancel_review', reason: c.cancel_reason}`.
- 신규 `confirm_uncancel_review(p_change_id uuid)` — kind='uncancel'. 원자적 claim → `reservations` 를 `new_*` 로 in-place 갱신 + `status` 재트리아지 + `cancelled_at=null, cancelled_by=null` → 다른 채널 block "막아라"(pending/block, 게스트하우스-stayfolio 제외) 생성 → `detected` 이벤트 `{source:'uncancel_review'}`.
- 셋 다 `security invoker`, `grant execute ... to authenticated`. 이미 `pending` 아니면 조용히 `return`.

- [ ] **Step 1: `confirm_reservation_change` 에 kind 가드**

claim UPDATE 의 `where id = p_change_id and status = 'pending'` → `... and status='pending' and kind='change'`. (다른 kind 를 이 함수로 부르면 no-op.)

- [ ] **Step 2: `confirm_cancel_review` 추가**

```sql
create or replace function confirm_cancel_review(p_change_id uuid)
returns void language plpgsql security invoker as $$
declare v_uid uuid := auth.uid(); c reservation_changes%rowtype; r reservations%rowtype;
begin
  select * into c from reservation_changes where id=p_change_id and status='pending' and kind='cancel';
  if not found then return; end if;
  select * into r from reservations where id=c.reservation_id;
  if not found then return; end if;

  update reservation_changes set status='confirmed', resolved_by=v_uid, resolved_at=now()
   where id=p_change_id and status='pending';
  if not found then return; end if;   -- 레이스에서 진 쪽

  update reservations set status='cancelled',
      cancelled_by=v_uid, cancelled_at=coalesce(cancelled_at, now())
   where id=c.reservation_id and status <> 'cancelled';

  update block_tasks set status='skipped'
   where reservation_id=c.reservation_id and status='pending' and action='block';
  update block_tasks set status='pending', action='unblock'
   where reservation_id=c.reservation_id and status='done' and action='block';

  insert into reservation_events (reservation_id, actor, type, detail)
    values (c.reservation_id, v_uid, 'cancelled',
            jsonb_build_object('source','cancel_review','reason', c.cancel_reason,
                               'cancel_source', c.cancel_source));
end; $$;
grant execute on function confirm_cancel_review(uuid) to authenticated;
```

- [ ] **Step 3: `confirm_uncancel_review` 추가**

```sql
create or replace function confirm_uncancel_review(p_change_id uuid)
returns void language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid(); c reservation_changes%rowtype; r reservations%rowtype;
  v_new_status reservation_status; v_is_guesthouse boolean;
begin
  select * into c from reservation_changes where id=p_change_id and status='pending' and kind='uncancel';
  if not found then return; end if;
  select * into r from reservations where id=c.reservation_id;
  if not found then return; end if;

  update reservation_changes set status='confirmed', resolved_by=v_uid, resolved_at=now()
   where id=p_change_id and status='pending';
  if not found then return; end if;

  v_new_status := case
    when c.new_payment_status='paid' then 'confirmed'
    when c.new_payment_status='pending' then 'awaiting_deposit'
    else 'new' end::reservation_status;
  v_is_guesthouse := coalesce(
    c.new_room_name like '객실 서쪽%' or c.new_room_name like '객실 남쪽%'
    or c.new_room_name like '서쪽방%' or c.new_room_name like '남쪽방%', false);

  update reservations set
    guest_name = coalesce(c.new_guest_name, guest_name),
    guest_phone = coalesce(c.new_guest_phone, guest_phone),
    room_name = coalesce(c.new_room_name, room_name),
    check_in = c.new_check_in, check_out = c.new_check_out,
    amount = coalesce(c.new_amount, amount),
    options = case when c.new_options <> '[]'::jsonb then c.new_options else options end,
    payment_method = c.new_payment_method, payment_status = c.new_payment_status,
    status = v_new_status,
    cancelled_by = null, cancelled_at = null,
    deposit_confirmed_by = null, deposit_confirmed_at = null,
    confirmed_by = null, confirmed_at = null
  where id = c.reservation_id;

  -- 취소되며 남았던 unblock 잔재 정리 + 다른 채널 다시 막기
  update block_tasks set status='skipped'
   where reservation_id=c.reservation_id and status='pending' and action='unblock';
  insert into block_tasks (reservation_id, target_channel, check_in, check_out, action, status)
    select c.reservation_id, ch2, c.new_check_in, c.new_check_out, 'block', 'pending'
    from unnest(enum_range(null::channel)) as ch2
    where ch2 <> r.channel and not (v_is_guesthouse and ch2 = 'stayfolio'::channel);

  insert into reservation_events (reservation_id, actor, type, detail)
    values (c.reservation_id, v_uid, 'detected', jsonb_build_object('source','uncancel_review'));
end; $$;
grant execute on function confirm_uncancel_review(uuid) to authenticated;
```

- [ ] **Step 4: 정적 리뷰**

3개 함수 모두 원자적 claim(`update ... where status='pending'` + `if not found then return`) 후 작업; `%rowtype` 컬럼 참조 유효; `grant ... to authenticated` 존재; `$$` 균형.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0023_reservation_change_review.sql
git commit -m "feat: 0023 kind별 확정 RPC — confirm_cancel_review / confirm_uncancel_review"
```

---

## Task 7: `0023` — reconcile용 enqueue 함수 + `staff_cancel` 유지 확인

**Files:** Modify: `supabase/migrations/0023_reservation_change_review.sql` (§ 끝에 추가)

**배경:** 현재 `reconcile-stayfolio-ics.ts` 는 `cancel_reservation(p_id, 'stayfolio_ics_missing')` 를 호출해 즉시 취소한다(마이그레이션 `0014` 정의). v2 에서는 즉시취소 대신 큐잉.

**Interfaces:**
- 신규 `enqueue_ics_cancel_review(p_reservation_id uuid) returns void` — `security definer`, `grant ... to service_role`. 해당 예약이 활성(`status <> 'cancelled'`)이고 pending 확인 건이 없으면 `reservation_changes` 에 `kind='cancel'`, `cancel_source='stayfolio_ics_missing'`, `prev_*`=현재 예약 스냅샷, `new_*`=현재 값 그대로 pending 생성 + `note` 이벤트. 이미 pending 이 있으면 no-op.
- `cancel_reservation(uuid, text)` (reconcile 전용, security definer) 는 **남겨두되** 더 이상 호출되지 않음(문서 주석). 또는 이 마이그레이션에서 그대로 둔다(다른 곳 참조 없음 확인).

- [ ] **Step 1: 함수 추가**

```sql
create or replace function enqueue_ics_cancel_review(p_reservation_id uuid)
returns void language plpgsql security definer as $$
declare r reservations%rowtype;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found or r.status = 'cancelled' then return; end if;
  if exists (select 1 from reservation_changes where reservation_id = p_reservation_id and status = 'pending') then
    return;
  end if;
  insert into reservation_changes (
    reservation_id, kind, cancel_source,
    prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
    new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
    new_amount, new_options, new_payment_method, new_payment_status, new_raw_payload
  ) values (
    p_reservation_id, 'cancel', 'stayfolio_ics_missing',
    r.check_in, r.check_out, r.room_name, r.amount, r.guest_name, coalesce(r.options,'[]'::jsonb),
    r.guest_name, r.guest_phone, r.room_name, r.check_in, r.check_out,
    r.amount, coalesce(r.options,'[]'::jsonb), r.payment_method, r.payment_status, r.raw_payload
  );
  insert into reservation_events (reservation_id, actor, type, detail)
    values (p_reservation_id, null, 'note',
            jsonb_build_object('source','cancel_review_queued','cancel_source','stayfolio_ics_missing'));
end; $$;
revoke all on function enqueue_ics_cancel_review(uuid) from public;
grant execute on function enqueue_ics_cancel_review(uuid) to service_role;
```

- [ ] **Step 2: 참조 확인 주석**

`0023` 끝에 주석: `-- cancel_reservation(uuid,text) (0014) 는 이제 미사용 — reconcile 은 enqueue_ics_cancel_review 를 호출. staff_cancel_reservation(달력 토글)은 즉시취소 그대로.`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0023_reservation_change_review.sql
git commit -m "feat: 0023 enqueue_ics_cancel_review — 스테이폴리오 ICS 누락도 확인 큐로"
```

---

## Task 8: `scripts/verify-0023.sql` — v2 시나리오

**Files:** Modify: `scripts/verify-0023.sql`

`_t_ing` 헬퍼에 `guest_request` 인자(default null) 추가하고 `drop function` 시그니처도 맞춘다. 기존 시나리오(1~10, RPC confirm/keep)는 유지하되 v2 동작에 맞게 기대값 조정(취소 메일이 이제 **즉시 cancelled 안 되고 kind='cancel' pending** 이 됨).

- [ ] **Step 1: 헬퍼 + 시나리오 추가**

추가할 `check` 시나리오:
- **취소 메일 → cancel 큐**: `_t_ing('C1', d, d2)` 신규 → `_t_ing('C1', d, d2, cancelled => true)` → `reservation_changes` 에 `kind='cancel'`, `status='pending'` 1건, **예약 status 는 여전히 `awaiting_deposit`/`confirmed`**.
- **cancel 확정**: `confirm_cancel_review(...)` → 예약 `status='cancelled'`, 큐 `confirmed`, block_tasks pending/block→skipped.
- **cancel 후 재접수 → uncancel 큐**: `_t_ing('C1', d, d2)` (cancelled=false) → `kind='uncancel'` pending.
- **uncancel 확정**: `confirm_uncancel_review(...)` → 예약 `status` 복구(paid→confirmed), `cancelled_at is null`, 다른 채널 block pending/block 재생성.
- **취소 대기 중 정상 재접수 → 자동 withdrawn**: `_t_ing('C2', d, d2)` → `_t_ing('C2', d, d2, cancelled=>true)` → `_t_ing('C2', d, d2)` (정상) → `kind='cancel'` 행 `status='withdrawn'`, 예약 활성 유지.
- **변경 대기 중 취소 메일 → kind 갈아끼움**: 날짜 변경 재수신(pending kind='change') → 취소 메일 → 같은 행 `kind='cancel'`.
- **guest_request 저장**: `_t_ing('G9', d, d2, guest_request => '늦은 체크인')` → `reservations.guest_request = '늦은 체크인'`; 재수신 시 `'반려동물 문의'` 로 갱신되고 **큐 생성 안 됨**.
- **change 트리거 축소**: 이름만 다른 재수신 → `reservation_changes` pending 0, 예약 `guest_name` 즉시 갱신.
- **enqueue_ics_cancel_review**: 활성 예약에 호출 → `kind='cancel'`, `cancel_source='stayfolio_ics_missing'` pending 1건; 두 번 호출해도 1건.

- [ ] **Step 2: 정적 확인** — `begin; ... rollback;` 유지, `_t_ing` drop 시그니처 일치, 모든 assert 가 `t` 를 기대.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-0023.sql
git commit -m "test: verify-0023 v2 시나리오 — cancel/uncancel 큐, 자동철회, guest_request"
```

---

## Task 9: `db-types` + `queries` — 필드 추가

**Files:** Modify: `lib/db-types.ts`, `lib/queries.ts`

- [ ] **Step 1: `lib/db-types.ts`**

`Reservation` 에 `check_out` 다음(기존 `prev_check_in/out` 근처):
```ts
  guest_request: string | null;
```
`ReservationChange` 에:
```ts
  kind: 'change' | 'cancel' | 'uncancel';
  cancel_reason: string | null;
  cancel_source: string | null;
  reservation_guest_request: string | null;   // 조인
```
`ReservationChangeStatus` 는 그대로(`pending|confirmed|kept|withdrawn`).

- [ ] **Step 2: `lib/queries.ts`**

`getReservations` 의 `.select('*')` 는 `guest_request` 자동 포함 — 변경 불필요.
`getPendingReservationChanges`:
- `.select('*, reservation:reservations(channel, notes, guest_request)')`
- 매핑에 `kind: row.kind`, `cancel_reason: row.cancel_reason`, `cancel_source: row.cancel_source`, `reservation_guest_request: row.reservation?.guest_request ?? null` 추가.
- 정렬은 `new_check_in` 그대로. `ReservationChangeRow` 인터페이스에도 새 컬럼 반영.

- [ ] **Step 3: 기존 테스트 픽스처 보강**

`lib/conflicts.test.ts`, `lib/stats.test.ts` 의 `makeReservation` 에 `guest_request: null` 추가(v1 에서 `prev_check_in/out` 추가했던 것과 동일 위치).

- [ ] **Step 4: `npx tsc --noEmit` → clean. `TZ=UTC npx vitest run` → 그대로 통과.**

- [ ] **Step 5: Commit**

```bash
git add lib/db-types.ts lib/queries.ts lib/conflicts.test.ts lib/stats.test.ts
git commit -m "feat: ReservationChange.kind/cancel_*, Reservation.guest_request 조회"
```

---

## Task 10: `lib/actions.ts` — 확정 액션

**Files:** Modify: `lib/actions.ts`

- [ ] **Step 1: 액션 추가**

`confirmReservationChange` 아래에:
```ts
export async function confirmCancelReview(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_cancel_review', { p_change_id: changeId });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function confirmUncancelReview(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_uncancel_review', { p_change_id: changeId });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}
```
`keepReservationChange` 는 그대로(공용).

- [ ] **Step 2: `npx tsc --noEmit` → clean.**

- [ ] **Step 3: Commit**

```bash
git add lib/actions.ts
git commit -m "feat: confirmCancelReview / confirmUncancelReview server actions"
```

---

## Task 11: reconcile + ingest 호출부

**Files:** Modify: `lib/mail/reconcile-stayfolio-ics.ts`, `lib/ingest.ts`

- [ ] **Step 1: `reconcile-stayfolio-ics.ts`**

"번호 사라짐 → 취소" 지점에서 `supabase.rpc('cancel_reservation', { p_id, p_reason: 'stayfolio_ics_missing' })` 호출을 `supabase.rpc('enqueue_ics_cancel_review', { p_reservation_id: <id> })` 로 교체. 반환 카운트/로그 문구도 "취소" → "취소 검토 큐 등록" 으로. 두 불변식(ICS 조회 실패 방 스킵 / 체크아웃 당일 제외) 로직은 그대로.

- [ ] **Step 2: `lib/ingest.ts`**

`supabase.rpc('ingest_reservation', { ... })` 호출에 `p_guest_request: parsed.guest_request` 추가(마지막). `IngestResult`/시그니처 변화 없음.

- [ ] **Step 3: `reconcile-stayfolio-ics.test.ts` 갱신**

기존 테스트가 `cancel_reservation` 호출을 검증한다면 `enqueue_ics_cancel_review` 로 기대 변경. (mock 대상 rpc 이름만.)

- [ ] **Step 4: `TZ=UTC npx vitest run && npx tsc --noEmit` → 통과.**

- [ ] **Step 5: Commit**

```bash
git add lib/mail/reconcile-stayfolio-ics.ts lib/mail/reconcile-stayfolio-ics.test.ts lib/ingest.ts
git commit -m "feat: reconcile 는 즉시취소 대신 확인 큐 등록 + ingest 가 guest_request 전달"
```

---

## Task 12: `Badges` + `ReservationChangeQueue` — kind별 카드

**Files:** Modify: `components/Badges.tsx`, `components/ReservationChangeQueue.tsx`, `app/globals.css`

**Interfaces:**
- `components/Badges.tsx`: `ChangeRequestBadge`(있음), 신규 `CancelRequestBadge`(`변경 요청` 대신 `취소 요청`, `.badge-cancel-request` 빨강), `UncancelRequestBadge`(`되살리기 요청`).
- `ReservationChangeQueue` props 확장: `onCancelConfirm: (id) => void`, `onUncancelConfirm: (id) => void`, `onKeep` 는 공용. `todayISO?`.

- [ ] **Step 1: `Badges.tsx`**

```tsx
export function CancelRequestBadge() {
  return <span className="badge badge-cancel-request">취소 요청</span>;
}
export function UncancelRequestBadge() {
  return <span className="badge badge-uncancel-request">되살리기 요청</span>;
}
```

- [ ] **Step 2: `ReservationChangeQueue.tsx` — kind 분기**

`pending.map((c) => ...)` 안에서 `c.kind` 로 3분기:

- `kind === 'change'` — 현행 v1 카드 그대로 (기존/변경 두 줄, `changeSummaryLabel(changedFields(...))`, `refundForChange(c.prev_check_in, c.prev_amount, todayISO)` 배너, 버튼 `[기존 예약 유지]`/`[변경 확정]`).
- `kind === 'cancel'` — 새 카드:
  ```tsx
  <div className="card">
    <div className="badge-row"><ChannelBadge channel={c.reservation_channel} />
      <span className="card-title">{c.prev_guest_name ?? '이름 미상'}</span></div>
    <div className="change-rows">
      <div className="change-row">
        {formatDateRange(c.prev_check_in, c.prev_check_out)} · {displayRoomName(c.prev_room_name)} · {formatWon(c.prev_amount)}
      </div>
      <div className="change-row"><em>취소 요청{c.cancel_reason ? ` — 사유: ${c.cancel_reason}` : ''}{c.cancel_source === 'stayfolio_ics_missing' ? ' (스테이폴리오 캘린더에서 사라짐)' : ''}</em></div>
      {c.reservation_guest_request && <div className="guest-request">손님 요청: {c.reservation_guest_request}</div>}
    </div>
    <PenaltyBanner refund={refundFor(c.prev_check_in, c.prev_amount, todayISO)} total={c.prev_amount} />
    <div className="badge-row">
      <button className="btn-secondary" onClick={() => onKeep(c.id)}>기존 예약 유지</button>
      <button className="btn-primary" onClick={() => onCancelConfirm(c.id)}>취소 확정</button>
    </div>
  </div>
  ```
  (`refundFor` from `../lib/refund`. `prev_*` = 취소 대상 예약의 현재 스냅샷이므로 현재 체크인 기준이 맞음.)
- `kind === 'uncancel'` — 카드: 예약 요약 1줄 + `<em>취소된 예약에 재접수 메일 도착 — 되살릴까요?</em>` + 버튼 `[취소 유지]`(→`onKeep`) / `[예약 되살리기]`(→`onUncancelConfirm`). 위약금 배너 없음.

`손님 요청` 줄은 `change` 카드에도 추가(`c.reservation_guest_request`).

- [ ] **Step 3: `globals.css`**

```css
.badge-cancel-request { background: var(--st-cancelled); color: #fff; }
.badge-uncancel-request { background: var(--st-new); color: #fff; }
.guest-request { font-size: 12px; color: var(--st-new); margin-top: 4px; }
```
(존재 변수만 사용. `--st-cancelled`, `--st-new` 확인됨.)

- [ ] **Step 4: `npx tsc --noEmit && npm run build` → 통과** (props 변경으로 `DashboardRealtime` 에서 tsc 에러 1개 예상 — T14 에서 해소. 그 외 에러는 이 태스크에서 수정.)

- [ ] **Step 5: Commit**

```bash
git add components/Badges.tsx components/ReservationChangeQueue.tsx app/globals.css
git commit -m "feat: 예약 확인 큐 kind별 카드 — 취소/되살리기 + 손님 요청 표시"
```

---

## Task 13: `ReservationList` + `RoomCalendar` — 손님 요청 줄 + kind별 배지

**Files:** Modify: `components/ReservationList.tsx`, `components/RoomCalendar.tsx`

**Interfaces:**
- `ReservationList` prop `pendingChangeReservationIds: Set<string>` (있음) → **3개로 분리**: `pendingByKind: { change: Set<string>; cancel: Set<string>; uncancel: Set<string> }`. (또는 `Map<string, 'change'|'cancel'|'uncancel'>` 하나 — 구현 선택, 아래 예시는 객체.)

- [ ] **Step 1: `ReservationList.tsx`**

- import 에 `CancelRequestBadge`, `UncancelRequestBadge`.
- props: `pendingChangeReservationIds` 제거, `pendingByKind: { change: Set<string>; cancel: Set<string>; uncancel: Set<string> }` 추가.
- `badge-row` 에서:
  ```tsx
  {pendingByKind.change.has(r.id) && <ChangeRequestBadge />}
  {pendingByKind.cancel.has(r.id) && <CancelRequestBadge />}
  {pendingByKind.uncancel.has(r.id) && <UncancelRequestBadge />}
  ```
- `card-meta` 에 `손님 요청` 줄 (prev-dates 줄 근처):
  ```tsx
  {r.guest_request && (<><br /><span className="guest-request">손님 요청: {r.guest_request}</span></>)}
  ```

- [ ] **Step 2: `RoomCalendar.tsx`**

`reservation.notes` 렌더 근처(v1 에서 `cal-prev-dates` 넣은 자리)에:
```tsx
{reservation.guest_request && (
  <span className="cal-guest-request">손님 요청: {reservation.guest_request}</span>
)}
```
`.cal-guest-request { font-size: 11px; color: var(--st-new); }` 를 `globals.css` 에 추가.

- [ ] **Step 3: tsc** — `DashboardRealtime` 호출부 에러는 T14 에서. 그 외 없어야.

- [ ] **Step 4: Commit**

```bash
git add components/ReservationList.tsx components/RoomCalendar.tsx app/globals.css
git commit -m "feat: 예약 카드/달력에 손님 요청 줄 + 취소/되살리기 배지"
```

---

## Task 14: `page.tsx` + `DashboardRealtime` — 배선 마무리

**Files:** Modify: `app/page.tsx`, `components/DashboardRealtime.tsx`

- [ ] **Step 1: `app/page.tsx`** — 변경 없음(이미 `getPendingReservationChanges` 로드). `guest_request` 는 `getReservations('*')` 로 자동 포함.

- [ ] **Step 2: `DashboardRealtime.tsx`**

- import: `confirmCancelReview`, `confirmUncancelReview` (`../lib/actions`).
- realtime `reservation_changes` 핸들러 — 그대로 두되 머지 객체에 `kind`, `cancel_reason`, `cancel_source`, `reservation_guest_request` 도 방어적 기본값 포함(payload 에 base 컬럼은 다 옴; 조인 필드만 `reservationsRef` 에서 보강 — `reservation_guest_request` 는 해당 예약의 `guest_request`).
- 낙관적 핸들러: 기존 `resolveChange(changeId, action, failMsg)` 재사용해 2개 추가:
  ```ts
  const handleCancelConfirm = (id: string) =>
    resolveChange(id, confirmCancelReview, '취소 확정에 실패했습니다. 다시 시도해 주세요.');
  const handleUncancelConfirm = (id: string) =>
    resolveChange(id, confirmUncancelReview, '예약 되살리기에 실패했습니다. 다시 시도해 주세요.');
  ```
- 파생값:
  ```ts
  const pendingByKind = {
    change: new Set(changes.filter((c) => c.status === 'pending' && c.kind === 'change').map((c) => c.reservation_id)),
    cancel: new Set(changes.filter((c) => c.status === 'pending' && c.kind === 'cancel').map((c) => c.reservation_id)),
    uncancel: new Set(changes.filter((c) => c.status === 'pending' && c.kind === 'uncancel').map((c) => c.reservation_id)),
  };
  const changeCount = changes.filter((c) => c.status === 'pending').length;
  ```
- quick-nav 항목 문구 `변경확인` → **`예약확인`** (`href="#changes"` 유지), 카운트 `changeCount`.
- `<ReservationChangeQueue>` 에 `onCancelConfirm={handleCancelConfirm} onUncancelConfirm={handleUncancelConfirm}` 추가(`onConfirm`=`handleConfirmChange`, `onKeep`=`handleKeepChange` 유지).
- `<ReservationList>` 에 `pendingChangeReservationIds` 제거, `pendingByKind={pendingByKind}` 전달.

- [ ] **Step 3: 전체 게이트**

Run: `TZ=UTC npx vitest run && npx tsc --noEmit && npm run build`
Expected: 전부 통과, tsc 0 에러.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx components/DashboardRealtime.tsx
git commit -m "feat: 대시보드 배선 — kind별 확정 핸들러·배지, '예약확인' 큐"
```

---

## Task 15: 통합 게이트 + 인수 문서

**Files:** none (검증) / Modify: `docs/superpowers/specs/2026-08-28-reservation-change-review-design.md` (배포 체크리스트 갱신)

- [ ] **Step 1: 전체 게이트**

```bash
TZ=UTC npx vitest run && npx tsc --noEmit && npm run build
```
전부 통과.

- [ ] **Step 2: 배포 체크리스트 갱신**

설계 문서 §V2-8 아래에 "배포 순서" 절 — (1) `0023` 적용(마이그레이션 먼저), (2) `verify-0023.sql` 전부 `t`, (3) `block_tasks` 제약명 확인, (4) 로그인 세션으로 `취소 확정`·`변경 확정`·`예약 되살리기` 각 1회 브라우저 검증(동시클릭 포함), (5) 앱 배포, (6) 머지.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-28-reservation-change-review-design.md
git commit -m "docs: v2 배포 체크리스트"
```

---

## Self-Review

**1. Spec coverage (v2 절 대비)**

| v2 항목 | Task |
|---|---|
| §V2-1 kind 3종 큐 | T4(스키마) T5(ingest) T6(RPC) |
| §V2-1 change 트리거 = 날짜·객실·옵션 | T3(헬퍼) T5(`v_changed`) |
| §V2-1 guest/amount/pay 단독 변경 = 즉시갱신+이벤트 | T5(값 동일 블록) |
| §V2-2 대기 중 상태·배지 | T12(배지) T13(리스트/달력) T14(집합) |
| §V2-3 자동 철회 (change/cancel) | T5(withdrawn 블록) |
| §V2-4 reconcile → 큐 | T7(enqueue 함수) T11(호출부) |
| §V2-5 guest_request 파서→컬럼→표시(메모 분리) | T1 T4 T9 T12 T13 |
| §V2-6 cancel 카드 위약금(현재 체크인) | T2(alias) T12(카드) |
| §V2-7 이벤트 타입 = 기존 enum 재사용 | T5·T6 (`detected`/`cancelled`/`note`) |
| §V2-8 브랜치 rework | 전 태스크 |
| §V2-0-A ICS 자동취소 큐로 | T7 T11 |
| §V2-0-B 확정 후 되살리기 = uncancel 큐 | T5(branch B) T6(`confirm_uncancel_review`) |
| §V2-0-C 객실 변경도 큐 | T3 T5(`v_changed` 에 room 포함) |

빠진 항목 없음.

**2. Placeholder scan** — `cancel_reason` 추출 경로(`p_raw->'fields'->>'취소사유'`)는 네이버 `raw_payload` 구조(`{source, fields, text}` — T5 배경 확인됨) 기준으로 구체화됨. 스테이폴리오 취소 메일의 사유 키는 파서 확인 필요 → T5 Step 1 에서 "구체 경로는 파서별 raw_payload 확인 후" 명시. 그 외 TBD 없음.

**3. Type consistency**
- `ChangedField` = `'dates'|'room'|'options'` (T3) — `ReservationChangeQueue`(T12)가 `changeSummaryLabel(changedFields(...))` 만 쓰므로 리터럴 참조 없음. OK.
- `ReservationChange.kind` (T9) = `'change'|'cancel'|'uncancel'` — T12 분기, T14 `pendingByKind` 필터에서 동일 리터럴. OK.
- `refundFor` (T2) = `refundForChange` alias, 시그니처 `(baseCheckIn, totalAmount, todayISO?)` — T12 `cancel` 카드가 `refundFor(c.prev_check_in, c.prev_amount, todayISO)` 로 호출. OK.
- RPC 이름: `confirm_cancel_review` / `confirm_uncancel_review` (T6) ↔ actions `confirm_cancel_review`/`confirm_uncancel_review` rpc 호출 (T10) ↔ `resolveChange(id, confirmCancelReview, …)` (T14). 일치.
- `ingest_reservation` 새 파라미터 `p_guest_request text default null` (T5) ↔ `lib/ingest.ts` `p_guest_request: parsed.guest_request` (T11) ↔ revoke/grant 인자 목록 `... jsonb, boolean, text` (T5). 일치.
- `pendingByKind: { change; cancel; uncancel }` (T13 prop) ↔ T14 생성 객체. 일치.
- `enqueue_ics_cancel_review(p_reservation_id uuid)` (T7) ↔ `reconcile` rpc 호출 인자명 (T11). 일치.

이슈 없음.
