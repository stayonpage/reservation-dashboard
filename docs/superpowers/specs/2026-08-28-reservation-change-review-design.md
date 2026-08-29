# 예약 변경 확인 워크플로우 + 위약금 표시 — 설계

- 작성일: 2026-08-28
- 대상 저장소: `숙박통합사이트` (sukbak-integration)
- 관련 파일: `lib/ingest.ts`, `supabase/migrations/0002_ingest_fn.sql`~`0022_*`, `components/DashboardRealtime.tsx`

## 1. 배경 / 현재 동작

같은 예약번호(`channel_reservation_id`)로 **변경 메일**이 다시 들어오면
`ingest_reservation` RPC 의 `ON CONFLICT DO UPDATE` 가 `check_in` / `check_out` /
`room_name` / `amount` / `options` / `guest_*` 를 **즉시 덮어쓴다.**

결과 문제:
- 원래(직전) 날짜·이력이 어디에도 안 남는다. `raw_payload` 도 같이 덮어써진다.
- 새 날짜에 대한 "다른 채널 막아라" 할 일(`block_tasks`)이 재생성되지 않는다
  (block_tasks 는 신규 예약일 때만 생성).
- 옛 날짜에 이미 막아둔 채널을 "다시 열어라"로 되돌리는 처리가 없다.
- `event_type` enum 에 `'updated'` 가 있으나 한 번도 emit 되지 않는다.

## 2. 목표

1. 변경 메일이 오면 예약을 즉시 바꾸지 않고 **"변경 확인" 대기 큐**에 올린다.
2. 대시보드에서 직원이 **[기존 예약 유지]** / **[변경 확정]** 두 버튼으로 처리한다.
   - **기존 예약 유지**: 변경 메일 무시, 옛 날짜·옛 막기 상태 그대로.
   - **변경 확정**: 예약을 새 값으로 교체 + 옛 날짜 "다시 열기" 할 일 + 새 날짜
     "막아라" 할 일 + 새 예약으로 재트리아지.
3. 변경 카드에 **직전 날짜 → 새 날짜**를 같이 보여준다 (직전 값 1개만; option B).
4. 변경으로 **위약금이 발생**하면 위약금액(원)을 카드에 표시한다.

## 3. 새 테이블 `reservation_changes` (변경 대기 큐)

변경 메일이 오면 `reservations` 는 건드리지 않고 이 테이블에 대기 행 1건을 만든다.

| 그룹 | 컬럼 |
|------|------|
| 식별 | `id uuid pk`, `reservation_id uuid not null references reservations(id) on delete cascade` |
| 직전 스냅샷 | `prev_check_in date not null`, `prev_check_out date not null`, `prev_room_name text`, `prev_amount integer`, `prev_guest_name text`, `prev_options jsonb not null default '[]'` |
| 새 값 | `new_guest_name text`, `new_guest_phone text`, `new_room_name text`, `new_check_in date not null`, `new_check_out date not null`, `new_amount integer`, `new_options jsonb not null default '[]'`, `new_payment_method payment_method not null`, `new_payment_status payment_status not null`, `new_raw_payload jsonb` |
| 상태 | `status text not null default 'pending'` (`pending` \| `confirmed` \| `kept` \| `withdrawn`), `resolved_by uuid references profiles(id)`, `resolved_at timestamptz`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` |

- `status` 의미: `pending`=직원 처리 대기, `confirmed`=변경 확정됨, `kept`=직원이 기존
  유지 선택, `withdrawn`=손님이 원래 값으로 되돌려 자동 철회됨(직원 액션 없음).

- 부분 유니크: `create unique index reservation_changes_one_pending on reservation_changes (reservation_id) where status = 'pending';`
  → 한 예약에 대기 변경은 항상 1건. 새 변경 메일이 또 오면 그 행을 최신값으로 갱신(upsert).
- `updated_at` 자동 갱신 트리거(기존 `set_updated_at()` 재사용).
- RLS: 기존 패턴과 동일 — `authenticated` 전체 CRUD, 파싱 워커(`service_role`)는 RLS 우회.
- Realtime: `alter publication supabase_realtime add table reservation_changes;`

## 4. `reservations` 컬럼 2개 추가

```sql
alter table reservations add column prev_check_in  date;
alter table reservations add column prev_check_out date;
```

`변경 확정` 시 직전 날짜를 여기 저장 → 전체 예약 카드/달력에서
"이전 3/9~3/10 에서 변경" 표시. option B 이므로 재변경 시 그때의 현재 날짜로 덮어쓴다.

## 5. 변경 감지 — `ingest_reservation` 수정 (마이그레이션 `0023`)

현재 배포된 정의(마이그레이션 `0012` 기준 + 이후 수정 반영)를 베이스로 재정의.
`ON CONFLICT` 시:

1. 들어온 소스 필드를 기존 행과 비교.
   - 비교 대상: `check_in`, `check_out`, `room_name`, `amount`, `guest_name`,
     `guest_phone`, `options`.
   - **비교 제외**: `raw_payload`(항상 다름), `payment_method` / `payment_status`
     (입금확인 워크플로우가 이미 별도 처리 — 이것만 바뀐 경우는 기존대로 갱신).
2. **동일** (들어온 값 == 현재 `reservations` 행) →
   - 해당 예약에 pending `reservation_changes` 행이 있으면 →
     `status='withdrawn', resolved_by=null, resolved_at=now()` 로 자동 철회
     (손님이 원래 값으로 되돌린 케이스). `reservation_events` 에 `note` 기록:
     `{note:'손님이 원래 예약 내용으로 되돌림 — 변경 요청 자동 철회', reverted_from:{...}}`.
   - pending 행이 없으면 → 기존 멱등 동작(아무것도 안 함, `raw_payload` 정도만 갱신).
3. **취소 메일**(`p_cancelled = true`) → 기존 즉시 처리 유지. 리뷰 큐 안 거침.
   (해당 예약에 pending 변경이 있으면 함께 `withdrawn` 처리 — 취소가 우선.)
4. **필드 변경** & 기존 `status <> 'cancelled'` →
   `reservations` 갱신하지 않고 `reservation_changes` 에 pending upsert:
   - `prev_*` = 현재 `reservations` 행 값
   - `new_*` = 들어온 파라미터 값
   - 이미 pending 행이 있으면(`reservation_changes_one_pending`) 그 행을 최신 `new_*` 로
     업데이트 + `updated_at` 갱신 (예: 3/9→3/20 대기 중 다시 3/20→3/25 로 바꾼 경우
     대기 건이 3/25 로 갱신됨; `prev_*` 는 최초값 3/9 유지 — 여전히 "직전=확정 전 상태").
   - `reservation_events` 에 `updated` 이벤트 기록:
     `detail = {source:'channel_notification', from:{check_in,check_out,...}, to:{...}}`
5. 함수 시그니처·권한(`revoke from public` / `grant to service_role`)는 기존과 동일하게 유지.

> **확정 이후 되돌림**: 직원이 `변경 확정`을 눌러 예약이 이미 3/20 이 된 뒤 손님이
> 3/20→3/9 로 되돌리면, 들어온 값(3/9)이 현재 예약(3/20)과 다르므로 4번 경로로 **새 pending
> 변경**이 생긴다(`prev_*`=3/20). 위약금도 `prev_check_in`=3/20 기준으로 다시 계산된다.
> 이는 의도된 동작 — 확정 후의 되돌림은 실제로 또 한 번의 변경이다.

> 참고: `raw_payload` 는 변경 감지로 큐에 올린 경우에도 최신 원문으로 갱신해 둔다
> (재파싱·감사 목적). 예약의 표시 필드는 확정 전까지 안 바뀐다.

## 6. 두 버튼 — RPC (마이그레이션 `0023`, `security invoker` + 감사기록)

### 6.1 `keep_reservation_change(p_change_id uuid)` — 기존 예약 유지

```
update reservation_changes
   set status='kept', resolved_by=auth.uid(), resolved_at=now()
 where id=p_change_id and status='pending';   -- found 아니면 조용히 무시(이미 처리됨)

if found:
  insert reservation_events(reservation_id, actor, type, detail)
    values(<res>, auth.uid(), 'note',
           jsonb_build_object('note','예약 변경 요청 거절 — 기존 예약 유지',
                              'from', ..., 'to', ...));
```

예약 원본·block_tasks 는 그대로.

### 6.2 `confirm_reservation_change(p_change_id uuid)` — 변경 확정

대상 change 행이 `pending` 이 아니면 조용히 무시.

1. change 행 + 현재 `reservations` 행 로드. 옛 날짜/채널/room_name/id 확보.
2. **예약 행을 새 값으로 in-place 갱신** (같은 `id` 유지):
   - `check_in/out`, `room_name`, `amount`, `guest_name`, `guest_phone`, `options`,
     `payment_method`, `payment_status`, `raw_payload` = change 의 `new_*`
   - `prev_check_in/out` = change 의 `prev_check_in/out`
   - `status` 재설정: `paid → confirmed`, `pending → awaiting_deposit`, else `new`
   - `deposit_confirmed_*` / `confirmed_*` 초기화(재트리아지)
   - `notes`(직원 메모)는 **보존**
3. **옛 날짜 block_tasks 정리** (해당 예약의 기존 태스크 대상):
   - `status='done'` → `status='pending', action='unblock'` (다시 열기), `check_in/out` = 옛 날짜 유지
   - `status='pending'` → `status='skipped'`
4. **새 날짜 block_tasks 생성**:
   - `insert ... select v_id, c, new_check_in, new_check_out from unnest(enum_range(null::channel)) c`
     `where c <> <예약채널> and not (v_is_guesthouse and c='stayfolio')`
   - `v_is_guesthouse` 판별은 기존 `ingest_reservation` 규칙 그대로:
     `room_name like '객실 서쪽%'|'객실 남쪽%'|'서쪽방%'|'남쪽방%'`
5. `reservation_events`:
   - `detected` — `detail={source:'reservation_change', from:{...}, to:{...}}`
   - `note` — `detail={note:'예약 변경 확정', actor 표시명}`
6. `reservation_changes` 행: `status='confirmed', resolved_by=auth.uid(), resolved_at=now()`.

> **DELETE 대신 in-place 갱신 이유**: 예약을 실제 삭제하면
> `reservation_changes`(FK `on delete cascade`)와 감사 이벤트·직원 메모가 같이 사라지고
> realtime 에서 `id` 가 바뀐다. in-place 갱신은 결과가 동일(옛 날짜 비우고 새 날짜 점유,
> 상태 재설정, 막기/열기 할 일 재생성, `detected` 재발생)하면서 이력을 지킨다.

## 7. 위약금 계산 — `lib/refund.ts` (신규 + `lib/refund.test.ts`)

취소(변경)/환불 규정:

| 체크인까지 남은 일수 | 환불율 | 위약금 |
|---|---|---|
| 10일 이상 | 100% | 없음 |
| 9일 | 90% | 총액의 10% |
| 8일 | 80% | 20% |
| 7일 | 70% | 30% |
| 6일 | 60% | 40% |
| 5일 | 50% | 50% |
| 4일 | 40% | 60% |
| 3일 이하 (0·음수 포함) | 0% (환불 불가) | 총액 전액 |

- **기준일수** = 한국시간 오늘(`kstTodayISO()`) → **기존(직전) 체크인**(`prev_check_in`)까지
  남은 일수(정수). "변경으로 깨는 약속"이 다가오는 예약이므로 기존 체크인 기준.
- **총 결제금액** = `prev_amount` (옵션 포함된 총액). `null` 이면 금액 계산 불가로 표기.
- 반올림: 위약금 = `round(total * (1 - rate))`, 환불가능 = `total - penalty`.

```ts
export interface RefundInfo {
  daysBefore: number;          // 오늘 → 기존 체크인, 정수 (음수 가능)
  refundRate: number;          // 0 ~ 1
  refundable: number | null;   // 환불 가능액(원), amount 없으면 null
  penalty: number | null;      // 위약금(원), amount 없으면 null
  hasPenalty: boolean;         // refundRate < 1
  amountKnown: boolean;        // prev_amount != null
}

export function refundForChange(
  prevCheckIn: string,
  prevAmount: number | null,
  todayISO = kstTodayISO(),
): RefundInfo;
```

날짜 계산은 `format.ts` 규칙 준수: `new Date(iso + 'T00:00:00Z')` + `getUTC*` 만 사용.

## 8. 대시보드 — 새 섹션 `components/ReservationChangeQueue.tsx`

`DepositQueue` / `BlockWorklist` 와 같은 패턴. `입금확인`·`막기` 근처에 배치.
`id="changes"` 로 quick-nav 앵커.

대기 건마다 카드:

```
[네이버] 홍길동
기존  3/9(월) ~ 3/10(화) · 객실 서쪽 · ₩150,000
변경  3/20(금) ~ 3/21(토) · 객실 서쪽 · ₩150,000     (날짜 변경)

⚠️ 위약금 ₩45,000 발생
   체크인 7일 전 변경 · 환불 가능 ₩105,000 (70%) · 총 결제 ₩150,000

          [ 기존 예약 유지 ]   [ 변경 확정 ]
```

- 변경된 필드만 라벨로 표시: `(날짜 변경)`, `(객실 변경)`, `(금액 변경)`, `(옵션 변경)`,
  `(예약자 변경)` — 여러 개면 나열.
- 위약금 배너 분기:
  - 남은 일수 ≥ 10 → `✓ 위약금 없음 (체크인 12일 전)`
  - 남은 일수 4~9 → `⚠️ 위약금 ₩{penalty} 발생` + 상세 줄
  - 남은 일수 ≤ 3 → `⚠️ 위약금 ₩{total} (전액) · 환불 불가` + `체크인 3일 이내 변경`
  - `amountKnown=false` → `⚠️ 위약금 발생 구간 (체크인 7일 전) · 금액 미상 — 위약금 수동 확인`
- 위약금액(원)은 배너 **첫 줄에 굵게**.
- 확정 버튼은 위약금이 있어도 막지 않는다(실제 환불은 직원이 수동 처리).
- quick-nav 에 `변경 N` 칩 추가 (`n-count`, 0이면 `zero` 클래스).

### 원래 예약 카드 배지

`ReservationList` 카드에 해당 예약의 pending 변경이 있으면 `변경 요청` 배지 표시
(`components/Badges.tsx` 에 추가). pending 변경 id 집합을 prop 으로 내려준다.

### 확정 후 카드 표시

`prev_check_in/out` 이 있는 예약은 카드/달력에 한 줄:
`이전 3/9~3/10 에서 변경` (`ReservationList`, `RoomCalendar`).

## 9. 서버 배선

### `lib/queries.ts`

```ts
export interface PendingReservationChange {
  id: string;
  reservation_id: string;
  channel: Channel;                 // 조인
  prev_check_in: string; prev_check_out: string;
  prev_room_name: string | null; prev_amount: number | null;
  prev_guest_name: string | null;
  new_check_in: string; new_check_out: string;
  new_room_name: string | null; new_amount: number | null;
  new_guest_name: string | null; new_options: ReservationOption[];
  created_at: string;
}
export async function getPendingReservationChanges(
  supabase: SupabaseClient,
): Promise<PendingReservationChange[]>;   // status='pending', order by new_check_in
```

`db-types.ts` 에 `ReservationChange` row 타입 추가. `Reservation` 에 `prev_check_in`,
`prev_check_out` 추가.

### `lib/actions.ts`

```ts
export async function keepReservationChange(changeId: string): Promise<{ error: string | null }>;
export async function confirmReservationChange(changeId: string): Promise<{ error: string | null }>;
```

기존 액션과 동일하게 `supabase.rpc(...)` → `revalidatePath('/')`.

### `app/page.tsx`

`getPendingReservationChanges` 를 `Promise.all` 에 추가, `DashboardRealtime` 에 prop 전달.

### `components/DashboardRealtime.tsx`

- `initialChanges` prop, `changes` state.
- realtime 구독에 `table: 'reservation_changes'` 추가:
  - `DELETE` / `status != 'pending'` 로의 UPDATE → 목록에서 제거
  - `INSERT` / pending UPDATE → upsert
  - 원본 페이로드엔 `channel` 조인이 없으므로, 없으면 `reservations` state 에서 채널을 찾아 병합.
- `handleKeepChange` / `handleConfirmChange`: 낙관적으로 목록에서 제거 → 서버 액션 →
  realtime 이 `reservations` / `block_tasks` 를 authoritative 값으로 재동기화.
- `<ReservationChangeQueue id="changes" ... />` 를 `DepositQueue` 위/근처에 렌더.
- quick-nav 항목 추가.

## 10. 테스트 (`vitest`, `TZ=UTC`)

- `lib/refund.test.ts`: 경계값 — 남은 일수 11/10/9/…/4/3/0/음수, `amount=null`,
  반올림 케이스.
- `lib/ingest` 감지 분기 테스트(기존 파서 테스트 패턴):
  - 동일 재수신(pending 없음) → no-op
  - 날짜 변경 → 큐 pending 생성
  - 취소 메일 → 즉시 처리(큐 안 탐), pending 있으면 withdrawn
  - pending 있는데 또 다른 날짜로 변경 → 같은 행 `new_*` 갱신, `prev_*` 유지
  - pending 있는데 원래 값으로 되돌림 → pending 행 `withdrawn`, 예약 원본 불변
  - 확정 후 되돌림 → 새 pending 생성(`prev_*` = 확정된 날짜)
- RPC 동작은 마이그레이션 리뷰로 검증(로컬 supabase 없으면 SQL 논리 검토 + 스테이징 수동).

## 11. 마이그레이션 파일

`supabase/migrations/0023_reservation_change_review.sql` 하나:
1. `create table reservation_changes` + 인덱스 + 트리거 + RLS + realtime publication
2. `alter table reservations add column prev_check_in / prev_check_out`
3. `create or replace function ingest_reservation(...)` — 변경 감지 분기 추가
4. `create function keep_reservation_change(uuid)` + grant
5. `create function confirm_reservation_change(uuid)` + grant

## 12. 범위 밖 (이번에 안 함)

- 달력 취소 토글(`staff_cancel_reservation`)에는 위약금 표시 미적용 — 이번 요청은
  "예약 변경" 흐름 한정.
- 실제 환불 실행/PG 연동 없음 — 위약금은 표시만, 처리는 직원 수동.
- 채널별 방 canonical 매핑(v2 과제) 손대지 않음.

---

# 개정 v2 — 2026-08-29 (취소도 큐로 + 손님 요청사항)

> 운영자 피드백으로 범위 확장. 위 v1 본문과 상충하는 부분은 **이 v2 절이 우선**한다.
> `feat/reservation-change-review` 브랜치(v1 구현분)는 이 절대로 rework 필요 — §V2-8 참조.

## V2-0. 확정 필요 (제 판단으로 기본값 잡음, 뒤집어도 됨)

| # | 항목 | 기본값(제안) |
|---|---|---|
| A | 스테이폴리오 ICS 누락 자동취소(`reconcile-stayfolio-ics`)도 큐로 보낼까 | **예 — 큐로.** 07/25·백필·08/29 오취소가 전부 이 경로. 직원이 스테이폴리오 확인 후 `취소 확정` 눌러야 취소됨 |
| B | "취소 확정"까지 끝난 뒤 손님이 되살린(재접수) 경우 | **큐에 '취소 철회 확인' 건으로 다시 뜸** → 직원이 `예약 되살리기` / `취소 유지` 선택 (방이 재판매됐을 수 있어 자동 복구 안 함) |
| C | `room_name`(객실) 변경도 큐로 보낼까 | **예 — 큐로.** 다른 유닛이므로 날짜 변경과 동급 영향 |

## V2-1. "변경 확인" 큐 → "예약 확인" 큐로 일반화

`reservation_changes` 테이블을 `kind` 로 3종을 담는다:

| `kind` | 트리거 | 확정 버튼 | 확정 시 동작 |
|--------|--------|-----------|--------------|
| `'change'` | 활성 예약에 **날짜(check_in/out) · 객실(room_name) · 옵션(options)** 중 하나라도 변경된 재수신 | `변경 확정` | v1 §6.2 그대로 (in-place 갱신 + 옛/새 날짜 block 재조정 + 재트리아지) |
| `'cancel'` | 취소 메일(`p_cancelled`) **또는** `reconcile-stayfolio-ics` 의 "번호 사라짐" 감지 | `취소 확정` | `status='cancelled'` + `cancelled_at` + `cancelled` 이벤트 + block_tasks: pending→skipped / done→pending+unblock (기존 `cancel_reservation` 로직) |
| `'uncancel'` | `status='cancelled'` 인 예약에 신규 접수 메일(네이버 `cancelled=false`) 또는 ICS 번호 재등장 | `예약 되살리기` | `status` 를 결제상태 기준 재설정 + `cancelled_at=null` + `detected` 이벤트 + 다른 채널 block "막아라" 재생성 |

- **왼쪽 버튼은 항상 `기존 예약 유지`** — 큐 행 `status='kept'` + `note`. 예약·block 그대로.
- `change` 감지 대상에서 **제외**: `guest_name`, `guest_phone`, `amount`, `payment_*` 단독 변경
  → 예약 본체 즉시 갱신(현행) + `updated` 이벤트만. (`amount` 는 위약금 계산에 쓰이므로
  큐에 이미 `cancel`/`change` 건이 있으면 그 스냅샷도 같이 최신화)

### `reservation_changes` 스키마 델타 (v1 대비)

```sql
alter table reservation_changes
  add column kind text not null default 'change'
      check (kind in ('change','cancel','uncancel')),
  add column cancel_reason text,          -- 'cancel' 일 때 채널이 준 사유 (네이버 취소사유 등)
  add column cancel_source text;          -- 'channel_notification' | 'stayfolio_ics_missing' | ...
-- prev_* 는 'cancel'/'uncancel' 에서도 "확정 직전 예약 상태" 스냅샷으로 그대로 사용.
-- 부분 유니크는 (reservation_id) where status='pending' 유지 — 한 예약에 열린 확인 건은 1개.
--   (변경 대기 중 취소 메일이 오면 그 pending 행을 kind='cancel' 로 갈아끼움: 취소가 우선)
```

## V2-2. 큐에 떠 있는 동안 예약 상태

- `change` / `cancel` 대기 중: 예약은 **원래 상태 그대로**(`confirmed` / `awaiting_deposit`).
  카드에 배지 — `변경 요청`(주황) / `취소 요청`(빨강).
- `uncancel` 대기 중: 예약은 `cancelled` 유지, 배지 `되살리기 요청`.
- 큐 카드 버튼:
  - `change` → `[기존 예약 유지]` `[변경 확정]`
  - `cancel` → `[기존 예약 유지]` `[취소 확정]` + **위약금 배너**(직전 체크인 기준, `lib/refund.ts` 그대로)
  - `uncancel` → `[취소 유지]` `[예약 되살리기]`

## V2-3. 자동 철회 (손님이 마음 바꿈)

v1 §5.2 "값 원복 → withdrawn" 을 kind 별로 확장:

| 대기 건 | 이후 들어온 메일 | 처리 |
|---------|------------------|------|
| `change` pending | 원래 값으로 되돌린 재수신 | `withdrawn` + `note` (v1 그대로) |
| `cancel` pending | 신규 접수 메일(네이버, `cancelled=false`) / ICS 번호 재등장 | `cancel` 행 `withdrawn` + `note` "손님이 취소 철회" — 예약 그대로 유지, 직원 액션 불필요 |
| `cancel` pending | 같은 취소 메일 재수신 | 무시(멱등) |

네이버는 취소 철회 시 같은 예약번호로 **접수 메일이 다시 온다**(실데이터: 접수/취소를 같은
번호로 별도 발송). 스테이폴리오는 불확실 → ICS 번호 재등장을 보조 신호로 사용하되, 못 잡으면
직원이 큐에서 `기존 예약 유지`(=`cancel` 건 kept) 로 수동 처리.

## V2-4. `reconcile-stayfolio-ics` 변경

현행: 번호 사라짐 → `cancel_reservation(p_id, 'stayfolio_ics_missing')` **즉시 취소**.
개정: 즉시 취소 대신 **`reservation_changes` 에 `kind='cancel'`, `cancel_source='stayfolio_ics_missing'` pending 행 생성**.
- 이미 같은 예약에 pending 확인 건이 있으면 건너뜀(중복 방지).
- 07/25·08/29 오취소 케이스가 여기서 직원 확인 게이트에 걸려 자동 사고가 사라짐.
- `lib/mail/reconcile-stayfolio-ics.ts` 의 두 불변식(ICS 조회 실패 방 스킵 / 체크아웃 당일 제외)은 유지.

## V2-5. 손님 요청사항 → 별도 표시 (메모란과 분리)

현재 파서(`naver.ts`, `stayfolio-email.ts`)가 `요청사항` 라벨을 읽지만 버린다(`raw_payload` 에만).

- `lib/types.ts` `ParsedReservation` 에 `guest_request: string | null` 추가.
- 파서: `요청사항` 값이 "요청사항이 없습니다." / "-" / 빈값이면 `null`, 아니면 그 텍스트.
- `reservations` 에 `guest_request text` 컬럼 추가. `ingest_reservation` 이 채운다
  (재수신 시 갱신 — 손님이 요청사항을 바꿀 수 있음). **`change` 큐 트리거 아님**(날짜/객실/옵션만).
- `reservations.notes`(직원 메모, 0015)와 **완전 분리** — 절대 섞지 않는다.
- 표시: 예약 카드 / 달력 / 큐 카드에 읽기전용 한 줄 —
  `손님 요청: 늦은 체크인 (오후 8시경 도착)`. `notes` 는 기존대로 직원 편집.
- `ReservationChange` 조인/표시에도 `guest_request` 포함(큐 카드에서 참고).

## V2-6. 위약금 배너 — `cancel` 카드에도

`lib/refund.ts` 그대로 재사용. 기준 = **취소 대상 예약의 현재 체크인**까지 남은 일수 · 현재 `amount`.
`change` 카드는 v1대로 직전 체크인 기준. 배너 문구/4분기 동일.

## V2-7. 이벤트 타입

`event_type` enum 에 값 추가 필요 여부 점검: `uncancel` 확정 시 `detected` 재사용(기존 enum).
`cancel` 확정은 `cancelled` 재사용. 새 enum 값 불필요 — `detail.source` 로 구분
(`'reservation_change'` / `'cancel_review'` / `'uncancel_review'`).

## V2-8. `feat/reservation-change-review` 브랜치 rework 범위

이미 구현된 v1 대비 필요한 변경:
1. `0023` 마이그레이션: `reservation_changes` 에 `kind`/`cancel_reason`/`cancel_source` 추가,
   `reservations` 에 `guest_request` 추가.
2. `ingest_reservation`: (a) `change` 감지를 **날짜·객실·옵션** 으로 축소, (b) 취소 메일을
   branch B 즉시처리 → `kind='cancel'` pending 생성으로 변경, (c) `cancelled` 예약에 접수
   메일 → `kind='uncancel'` pending, (d) `guest_request` 채우기.
3. 새 RPC: `confirm_cancel_review` / `confirm_uncancel_review` (또는 `confirm_reservation_change`
   를 kind 분기). `keep_reservation_change` 는 kind 공용.
4. `cancel_reservation`(reconcile 용) → pending 생성 함수로 교체.
5. `lib/types.ts` + 파서 2개: `guest_request`.
6. `lib/refund.ts`: `cancel` 용 진입점(현재 체크인 기준) 추가 — 순수함수라 인자만 다름.
7. UI: `ReservationChangeQueue` → kind별 카드/버튼, `취소 요청`/`되살리기 요청` 배지,
   `손님 요청` 줄(카드·`ReservationList`·`RoomCalendar`).
8. 테스트: 감지 분기 6종(날짜/옵션/객실 → change, 취소메일 → cancel, ICS누락 → cancel,
   재접수 → uncancel/withdraw), `refund` 취소 기준, kind별 확정 RPC.

## V2-9. 범위 밖 (여전히)

- 실제 환불/PG 연동 없음 — 위약금은 표시만.
- 달력의 수동 취소 토글(`staff_cancel_reservation`)은 즉시 취소 유지(직원이 직접 누른 것이라 확인 게이트 불필요).
- `amount` 변경 자체는 큐 트리거 아님(스냅샷만 갱신).
