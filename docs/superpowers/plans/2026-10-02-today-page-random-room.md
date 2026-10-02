# "오늘의 페이지" 랜덤객실 배정 Implementation Plan

> **2026-10-02 전체 리뷰 후 수정 (이 플랜 완료 후 발견):** Task 3의 `on conflict (...) do nothing`은
> 실제로 적용되지 않았다 — 운영 DB `block_tasks`에 그 unique 제약이 없어서(0001_init.sql과 달리
> 0023 §3에서 의도적으로 제거됨, drift 아님). `where not exists`로 교체했고, 거기에 더해
> **배정 전 직원이 ingest-time 네이버·스테이폴리오 태스크를 먼저 체크(done)해버리면 배정 후
> 재생성이 안 되는 오버부킹 버그**를 찾아 "배정 시 done 태스크 재오픈" 로직을 추가했다. 최종
> 구현은 `supabase/migrations/0027_assign_random_room.sql` / `scripts/verify-0027.sql`이 기준이고,
> 아래 Task 3 본문(이미 실행된 과거 지시문)은 당시 작성본 그대로 남겨둔다. 상세: 설계 문서 §4 상단
> 노트.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 예약확인 큐에서 "오늘의 페이지"(아임웹 가상 랜덤객실) 예약에 실제 객실(page26/452/8/127)을 배정하면, 해당 예약의 `room_name`이 갱신되고 아임웹·네이버·스테이폴리오 3채널 전부에 막기 할 일이 자동 생성된다.

**Architecture:** 새 Postgres RPC(`assign_random_room`, security invoker)가 `reservations.room_name` 갱신 + `block_tasks` 3건 insert(기존 `ingest_reservation`의 2채널 패턴과 달리 3채널 전부)를 원자적으로 수행. 기존 `BlockWorklist` 컴포넌트는 `reservation_id` 조인으로 표시하므로 수정 없이 그대로 새 할 일을 보여준다. `ReservationList`에 조건부 드롭다운 UI 하나만 추가.

**Tech Stack:** Next.js(App Router) + Supabase(Postgres, RPC, Realtime) + vitest. 기존 레포 컨벤션을 그대로 따름.

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-10-02-today-page-random-room-design.md` (이 플랜의 모든 과제는 그 문서 기준)
- 랜덤객실 상품명(아임웹)은 정확히 `오늘의 페이지` — 매칭에 이 문자열을 그대로 쓴다.
- 배정값(room_name)은 책 제목 없이 순수 코드(`'page26'` 등)만 저장한다 — 책 제목은 수시로 바뀌는 값이라 하드코딩 금지.
- DB 마이그레이션은 이 프로젝트에서 Supabase 브랜칭을 못 쓰므로(Pro 전용), 기존 관행대로 **운영 DB SQL Editor에 직접 붙여넣어 실행** — 각 마이그레이션 파일 내용을 채팅 코드블록으로 그대로 복사해서 실행(pbcopy 경유는 인코딩 깨짐 전례 있음, 기존 프로젝트 메모 참고).
- 이 프로젝트엔 React 컴포넌트 자동 테스트 인프라가 없다(vitest는 `lib/*.test.ts` 순수 함수만 커버) — UI 쪽은 새 테스트 프레임워크를 들이지 않고, 기존 관행대로 dev 서버 수동 스모크로 검증한다.

---

## Task 1: `TODAY_PAGE_PRODUCT_NAME` 상수 + 순수 코드 매칭 테스트

**Files:**
- Modify: `lib/rooms.ts`
- Test: `lib/rooms.test.ts`

**Interfaces:**
- Produces: `TODAY_PAGE_PRODUCT_NAME: string` (export) — 이후 Task 5(UI)에서 이 상수로 "배정 대기" 카드를 판별.
- Produces: `roomCodeOf('page26')` 이 책 제목 없는 순수 코드도 정확히 매칭함을 보장(이미 되는 동작이지만 Task 5가 의존하는 전제라 회귀 가드로 명시 테스트).

- [ ] **Step 1: 실패하는 테스트 작성**

`lib/rooms.test.ts`의 `describe('roomCodeOf', ...)` 블록 안, 기존 `it('매칭 안 되는 방/null은 null', ...)` 바로 뒤에 추가:

```ts
  it('책 제목 없는 순수 코드도 매칭한다(랜덤객실 배정값)', () => {
    expect(roomCodeOf('page26')).toBe('page26');
    expect(roomCodeOf('page127')).toBe('page127');
  });
```

- [ ] **Step 2: 테스트 실행해서 통과 확인 (이미 구현돼 있어야 함)**

Run: `npx vitest run lib/rooms.test.ts`
Expected: 전부 PASS (`roomCodeOf`의 기존 구현이 이미 이 케이스를 지원 — 새 코드 불필요, 회귀 가드 역할만).

만약 FAIL이면(= 기존 구현이 바뀐 상태라면) `roomCodeOf`를 손대지 말고 즉시 이 작업을 중단하고 보고할 것 — Task 5 설계 전제가 깨진 것이므로 플랜 재검토 필요.

- [ ] **Step 3: `TODAY_PAGE_PRODUCT_NAME` 상수 추가**

`lib/rooms.ts`의 `ROOMS` 배열 선언 바로 위에 추가:

```ts
// 아임웹 평일 전용 랜덤객실 가상 상품. 예약 확정 시 직원이 실제 객실(page26/452/8/127)을
// 배정하기 전까지 room_name이 이 값 그대로 남아있다 — 배정 대기 판별에 쓴다(lib/actions.ts,
// components/ReservationList.tsx). 아임웹 상품명과 정확히 일치해야 함(2026-10-02 등록).
export const TODAY_PAGE_PRODUCT_NAME = '오늘의 페이지';

```

- [ ] **Step 4: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 5: 커밋**

```bash
git add lib/rooms.ts lib/rooms.test.ts
git commit -m "feat: 오늘의 페이지 상수 + 순수 코드 매칭 회귀 테스트"
```

---

## Task 2: 마이그레이션 0026 — `event_type`에 `room_assigned` 추가

**Files:**
- Create: `supabase/migrations/0026_add_room_assigned_event_type.sql`

**Interfaces:**
- Produces: `event_type` enum에 `'room_assigned'` 값 추가 — Task 3의 `assign_random_room` 함수가 이 값을 `reservation_events.type`에 씀.

- [ ] **Step 1: 마이그레이션 파일 작성**

`supabase/migrations/0026_add_room_assigned_event_type.sql`:

```sql
-- "오늘의 페이지" 랜덤객실을 실제 객실로 배정할 때 남기는 감사 이벤트 타입.
-- alter type ... add value는 같은 트랜잭션 내에서 바로 못 써서(Postgres 제약) 별도 파일로 분리
-- (0027에서 이 값을 쓰는 assign_random_room 함수를 정의).
alter type event_type add value if not exists 'room_assigned';
```

- [ ] **Step 2: 운영 DB에 적용**

Supabase 프로젝트(`kolhfqdmnpgviylsmccd`) SQL Editor에 위 파일 내용을 그대로 붙여넣어 Run. 에러 없이 끝나면 성공(SELECT 결과 없음 — DDL만).

- [ ] **Step 3: 커밋**

```bash
git add supabase/migrations/0026_add_room_assigned_event_type.sql
git commit -m "feat(db): room_assigned 이벤트 타입 추가 (0026)"
```

---

## Task 3: 마이그레이션 0027 — `assign_random_room` RPC + 검증 스크립트

**Files:**
- Create: `supabase/migrations/0027_assign_random_room.sql`
- Create: `scripts/verify-0027.sql`

**Interfaces:**
- Consumes: `event_type` enum의 `'room_assigned'`(Task 2), `ingest_reservation` RPC(기존, 테스트 데이터 세팅용), `channel` enum(기존: `imweb`/`naver`/`stayfolio`).
- Produces: `assign_random_room(p_reservation_id uuid, p_room_name text) returns void` — Task 4(서버 액션)가 이 RPC를 호출.

- [ ] **Step 1: 검증 스크립트 먼저 작성 (실패할 걸 아는 상태로)**

`scripts/verify-0027.sql` — `scripts/verify-0024.sql`과 동일한 `begin...rollback` 패턴:

```sql
-- 0027 검증 — 0026 이 이미 적용된 DB(운영 포함) 에서 실행.
-- assign_random_room 세 시나리오(정상 배정/재배정 멱등/취소된 예약 거부)를 begin…rollback 으로 검증. 무변경.
-- 성공 시 'ALL PASSED' 한 행, 실패 시 ERROR: FAIL: <라벨>.

begin;

-- 0027 본문 (아직 없음 — Step 3에서 추가 후 이 스크립트를 다시 실행해 PASS 확인)

-- 헬퍼: 오늘의 페이지로 예약 하나 접수
create or replace function _t_rand(cid text)
returns uuid language sql as $$
  select ingest_reservation('imweb'::channel, cid, '홍길동', '010-1', '오늘의 페이지',
    date '2026-11-02', date '2026-11-03', 190000, '[]'::jsonb, 'card'::payment_method,
    'paid'::payment_status, jsonb_build_object('t', now()), false, null);
$$;

do $$
declare
  v_res_id uuid;
  v_room_name text;
  v_block_count int;
  v_imweb_count int;
begin
  -- 시나리오 A: 정상 배정 → room_name 갱신 + 3채널(imweb 포함) block_tasks 생성
  v_res_id := _t_rand('R1');
  perform assign_random_room(v_res_id, 'page26');

  select room_name into v_room_name from reservations where id = v_res_id;
  if v_room_name <> 'page26' then
    raise exception 'FAIL: %', 'A: room_name이 page26으로 안 바뀜';
  end if;

  select count(*) into v_block_count from block_tasks where reservation_id = v_res_id;
  if v_block_count <> 3 then
    raise exception 'FAIL: %', 'A: block_tasks가 3건이 아님 (실제 ' || v_block_count || ')';
  end if;

  select count(*) into v_imweb_count from block_tasks
   where reservation_id = v_res_id and target_channel = 'imweb';
  if v_imweb_count <> 1 then
    raise exception 'FAIL: %', 'A: 아임웹 채널 block_task가 없음 (평소엔 제외되는데 이번엔 있어야 함)';
  end if;

  if not exists (
    select 1 from reservation_events
     where reservation_id = v_res_id and type = 'room_assigned'
  ) then
    raise exception 'FAIL: %', 'A: room_assigned 이벤트가 안 남음';
  end if;

  -- 시나리오 B: 같은 예약 재배정(실수 정정) → block_tasks 중복 생성 안 됨(unique 제약으로 멱등)
  perform assign_random_room(v_res_id, 'page452');
  select room_name into v_room_name from reservations where id = v_res_id;
  if v_room_name <> 'page452' then
    raise exception 'FAIL: %', 'B: 재배정 후 room_name이 page452로 안 바뀜';
  end if;
  select count(*) into v_block_count from block_tasks where reservation_id = v_res_id;
  if v_block_count <> 3 then
    raise exception 'FAIL: %', 'B: 재배정 후 block_tasks가 3건이 아님(멱등 깨짐, 실제 ' || v_block_count || ')';
  end if;

  -- 시나리오 C: 취소된 예약은 배정 거부
  perform _t_ing_cancel('R2');
  begin
    perform assign_random_room(
      (select id from reservations where channel_reservation_id = 'R2'), 'page8'
    );
    raise exception 'FAIL: %', 'C: 취소된 예약인데 예외 없이 통과함';
  exception
    when others then
      if sqlerrm not like '%취소된 예약%' then
        raise exception 'FAIL: %', 'C: 다른 이유로 실패함: ' || sqlerrm;
      end if;
  end;
end $$;

drop function _t_rand(text);

select 'ALL PASSED — 0027 OK' as result;

rollback;
```

이 스크립트는 `_t_ing_cancel` 헬퍼를 시나리오 C에서 쓰는데 아직 정의가 없다 — 같은 `do $$` 블록 위, `_t_rand` 함수 정의 바로 아래에 추가:

```sql
create or replace function _t_ing_cancel(cid text)
returns uuid language sql as $$
  select ingest_reservation('imweb'::channel, cid, '김철수', '010-2', '오늘의 페이지',
    date '2026-11-10', date '2026-11-11', 190000, '[]'::jsonb, 'card'::payment_method,
    'paid'::payment_status, jsonb_build_object('t', now()), true, null);
$$;
```

(그리고 마지막 `drop function _t_rand(text);` 다음 줄에 `drop function _t_ing_cancel(text);` 추가.)

- [ ] **Step 2: 운영 DB에서 실행해서 실패 확인**

SQL Editor에 `scripts/verify-0027.sql` 전체 붙여넣어 Run.
Expected: `assign_random_room` 함수가 없어서 에러(`function assign_random_room(uuid, text) does not exist`) — `begin...rollback`이라 실패해도 DB엔 영향 없음.

- [ ] **Step 3: `assign_random_room` 함수 작성**

`supabase/migrations/0027_assign_random_room.sql`:

```sql
-- "오늘의 페이지"(아임웹 평일 전용 랜덤객실) 예약을 직원이 실제 객실로 배정.
-- design doc: docs/superpowers/specs/2026-10-02-today-page-random-room-design.md
--
-- toggle_block_task/confirm_deposit(0003)과 같은 패턴 — 직원이 로그인 상태로 누르는 액션이라
-- security invoker + auth.uid()(definer 아님, 0025의 search_path 고정 대상도 아님).
--
-- block_tasks는 3채널(imweb 포함) 전부 생성한다 — 보통 ingest_reservation은 들어온 채널을
-- 제외한 2채널만 만드는데(같은 상품 캘린더라 자동으로 막히므로), "오늘의 페이지"는 실제
-- 배정 객실과 아임웹에서도 서로 다른 상품(=다른 캘린더)이라 아임웹도 수동으로 막아야 한다.
create or replace function assign_random_room(
  p_reservation_id uuid,
  p_room_name text  -- 순수 객실 코드만, 예: 'page26' (책 제목 안 붙임 — design doc 6절)
)
returns void
language plpgsql
security invoker
as $$
declare
  v_prev_room_name text;
  v_check_in date;
  v_check_out date;
  v_status reservations.status%type;
  v_uid uuid := auth.uid();
begin
  select room_name, check_in, check_out, status
    into v_prev_room_name, v_check_in, v_check_out, v_status
    from reservations
   where id = p_reservation_id
     for update;

  if not found then
    raise exception '예약을 찾을 수 없습니다: %', p_reservation_id;
  end if;

  if v_status = 'cancelled' then
    raise exception '취소된 예약은 배정할 수 없습니다';
  end if;

  update reservations
     set room_name = p_room_name
   where id = p_reservation_id;

  -- 3채널 전부 막기 태스크 생성. 멱등: (reservation_id, target_channel) unique라
  -- 재배정으로 또 호출돼도 중복 insert 안 됨(이미 있는 채널은 조용히 스킵).
  insert into block_tasks (reservation_id, target_channel, check_in, check_out)
    select p_reservation_id, c, v_check_in, v_check_out
      from unnest(enum_range(null::channel)) as c
    on conflict (reservation_id, target_channel) do nothing;

  insert into reservation_events (reservation_id, actor, type, detail)
    values (
      p_reservation_id,
      v_uid,
      'room_assigned',
      jsonb_build_object('prev_room_name', v_prev_room_name, 'new_room_name', p_room_name)
    );
end;
$$;

grant execute on function assign_random_room(uuid, text) to authenticated;
```

- [ ] **Step 4: 운영 DB에 적용**

SQL Editor에 `supabase/migrations/0027_assign_random_room.sql` 내용 붙여넣어 Run.

- [ ] **Step 5: 검증 스크립트 재실행해서 통과 확인**

SQL Editor에 `scripts/verify-0027.sql` 전체 다시 붙여넣어 Run.
Expected: 마지막 행 `ALL PASSED — 0027 OK` 한 줄만 출력.

- [ ] **Step 6: 커밋**

```bash
git add supabase/migrations/0027_assign_random_room.sql scripts/verify-0027.sql
git commit -m "feat(db): assign_random_room RPC — 랜덤객실 실제 배정 + 3채널 막기 (0027)"
```

---

## Task 4: 서버 액션 `assignRandomRoom`

**Files:**
- Modify: `lib/actions.ts`

**Interfaces:**
- Consumes: `assign_random_room` RPC(Task 3).
- Produces: `assignRandomRoom(reservationId: string, roomCode: string): Promise<{ error: string | null }>` (export) — Task 6(DashboardRealtime 핸들러)이 이 함수를 호출.

- [ ] **Step 1: 액션 추가**

`lib/actions.ts` 맨 끝(`confirmUncancelReview` 함수 뒤)에 추가:

```ts

// "오늘의 페이지"(랜덤객실) 예약에 실제 객실을 배정 — room_name 갱신 + 3채널(아임웹 포함)
// 막기 태스크 생성을 RPC 하나로 원자적으로 처리(supabase/migrations/0027_assign_random_room.sql).
export async function assignRandomRoom(
  reservationId: string,
  roomCode: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('assign_random_room', {
    p_reservation_id: reservationId,
    p_room_name: roomCode,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}
```

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 3: 커밋**

```bash
git add lib/actions.ts
git commit -m "feat: assignRandomRoom 서버 액션"
```

---

## Task 5: UI — `ReservationList`에 객실 배정 드롭다운

**Files:**
- Modify: `components/ReservationList.tsx`

**Interfaces:**
- Consumes: `TODAY_PAGE_PRODUCT_NAME`(Task 1, `lib/rooms.ts`), `ROOMS`(기존, `lib/rooms.ts`).
- Produces: `ReservationList`의 props에 `onAssignRoom: (reservationId: string, roomCode: string) => void` 추가(필수 prop) — Task 6에서 `DashboardRealtime`이 이 prop을 채워 넘김.

- [ ] **Step 1: import 추가**

`components/ReservationList.tsx` 상단 import 블록, 기존 `import { displayRoomName } from '../lib/rooms';`를 다음으로 교체:

```ts
import { displayRoomName, ROOMS, TODAY_PAGE_PRODUCT_NAME } from '../lib/rooms';
```

- [ ] **Step 2: 배정용 객실 목록 상수 + 컴포넌트 로컬 상태 추가**

`COLLAPSED_COUNT` 상수 선언 바로 아래에 추가:

```ts
const ASSIGNABLE_ROOMS = ROOMS.filter((r) => r.code.startsWith('page'));
```

컴포넌트 함수 시작부(`const [tab, setTab] = useState...` 바로 아래)에 추가:

```ts
  const [selectedRoom, setSelectedRoom] = useState<Record<string, string>>({});
```

- [ ] **Step 3: props 타입에 `onAssignRoom` 추가**

함수 시그니처를 다음으로 교체:

```ts
export function ReservationList({
  reservations,
  blockTasks,
  pendingByKind,
  onAssignRoom,
  id,
}: {
  reservations: Reservation[];
  blockTasks: BlockTask[];
  pendingByKind: { change: Set<string>; cancel: Set<string>; uncancel: Set<string> };
  onAssignRoom: (reservationId: string, roomCode: string) => void;
  id?: string;
}) {
```

- [ ] **Step 4: 카드 안에 드롭다운 + 확정 버튼 렌더링**

`{r.options.length > 0 && (...)}` 블록(card-meta 안, 마지막 조건부 렌더) 바로 뒤, `</div>`(card-meta 닫는 태그) 앞에 추가:

```tsx
                    {r.room_name === TODAY_PAGE_PRODUCT_NAME && r.status !== 'cancelled' && (
                      <>
                        <br />
                        <span className="today-page-assign">
                          실제 객실 배정:{' '}
                          <select
                            value={selectedRoom[r.id] ?? ''}
                            onChange={(e) =>
                              setSelectedRoom((prev) => ({ ...prev, [r.id]: e.target.value }))
                            }
                          >
                            <option value="">선택</option>
                            {ASSIGNABLE_ROOMS.map((room) => (
                              <option key={room.code} value={room.code}>
                                {room.label}
                              </option>
                            ))}
                          </select>{' '}
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={!selectedRoom[r.id]}
                            onClick={() => onAssignRoom(r.id, selectedRoom[r.id])}
                          >
                            배정 확정
                          </button>
                        </span>
                      </>
                    )}
```

- [ ] **Step 5: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음(이 시점에선 `DashboardRealtime`에서 `onAssignRoom`을 안 넘겨서 에러가 날 것 — 정상. Task 6에서 해결)

- [ ] **Step 6: 커밋**

```bash
git add components/ReservationList.tsx
git commit -m "feat(ui): 오늘의 페이지 예약에 실제 객실 배정 드롭다운 추가"
```

---

## Task 6: `DashboardRealtime`에 핸들러 연결

**Files:**
- Modify: `components/DashboardRealtime.tsx`

**Interfaces:**
- Consumes: `assignRandomRoom`(Task 4, `lib/actions.ts`), `ReservationList`의 `onAssignRoom` prop(Task 5).

- [ ] **Step 1: import에 `assignRandomRoom` 추가**

`lib/actions.ts`에서 가져오는 import 블록(`confirmUncancelReview,` 다음 줄)에 추가:

```ts
  assignRandomRoom,
```

- [ ] **Step 2: 핸들러 추가**

`handleConfirmDeposit` 함수 바로 뒤에 추가 — `resolveChange`와 같은 낙관적 업데이트+실패시 롤백+성공시 syncAll 패턴(block_tasks 조인 필드를 realtime payload가 안 주므로 새 block_tasks 3건을 정확히 보여주려면 재조회 필요):

```ts
  const handleAssignRandomRoom = (reservationId: string, roomCode: string) => {
    const prevRoomName = reservations.find((r) => r.id === reservationId)?.room_name ?? null;
    setReservations((prev) =>
      prev.map((r) => (r.id === reservationId ? { ...r, room_name: roomCode } : r)),
    );
    startTransition(() => {
      assignRandomRoom(reservationId, roomCode).then((res) => {
        if (!res.error) {
          syncAll();
          return;
        }
        console.error('객실 배정 실패:', res.error);
        setReservations((prev) =>
          prev.map((r) => (r.id === reservationId ? { ...r, room_name: prevRoomName } : r)),
        );
        if (typeof window !== 'undefined') window.alert('객실 배정 실패: ' + res.error);
      });
    });
  };
```

- [ ] **Step 3: `ReservationList`에 prop 전달**

`<ReservationList ... />` 호출부를 다음으로 교체:

```tsx
      <ReservationList
        id="list"
        reservations={reservations}
        blockTasks={blockTasks}
        pendingByKind={pendingByKind}
        onAssignRoom={handleAssignRandomRoom}
      />
```

- [ ] **Step 4: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 5: 커밋**

```bash
git add components/DashboardRealtime.tsx
git commit -m "feat(ui): 객실 배정 핸들러를 DashboardRealtime에 연결"
```

---

## Task 7: 전체 테스트 + 수동 스모크

**Files:** 없음(검증 전용)

- [ ] **Step 1: 전체 vitest 실행**

Run: `npx vitest run`
Expected: 전부 PASS(Task 1에서 추가한 테스트 포함, 기존 테스트 전부 그대로 통과)

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 성공

- [ ] **Step 3: dev 서버로 수동 스모크**

Run: `npm run dev`, 브라우저로 로그인 후:

1. "📝 예약 수동 입력"으로 테스트 예약 생성 — 채널 아임웹, 방은 드롭다운에 없으니 코드로 직접 입력이 안 되면 `createManualReservation` 호출 전 임시로 room 드롭다운에 `오늘의 페이지` 옵션이 없을 수 있음(`ManualReservationForm`은 `ROOMS` 배열만 씀, 랜덤객실은 거기 없음) — 이 경우 SQL Editor에서 `scripts/verify-0027.sql`의 `_t_rand` 헬퍼처럼 `ingest_reservation`을 한 번 직접 호출해 `room_name='오늘의 페이지'`인 예약을 수동으로 만들어도 됨(테스트용, rollback 없이 커밋해서 대시보드에 실제로 뜨게).
2. 전체 예약 리스트에서 해당 카드에 "실제 객실 배정" 드롭다운이 보이는지 확인.
3. 객실 하나 선택 → "배정 확정" 클릭.
4. 카드의 방 표시가 선택한 객실로 바뀌는지 확인(드롭다운은 사라짐 — room_name이 더 이상 `오늘의 페이지`가 아니므로).
5. "막아야 할 채널" 섹션에 아임웹·네이버·스테이폴리오 3건이 해당 예약 손님명·객실명과 함께 새로 뜨는지 확인.
6. 3건 중 하나를 완료 체크 → 목록에서 바로 사라지는지(기존 BlockWorklist 동작 그대로) 확인.

- [ ] **Step 4: 테스트용 데이터 정리**

SQL Editor에서 테스트로 만든 예약을 지운다(실제 운영 데이터가 아니므로):

```sql
delete from block_tasks where reservation_id = (
  select id from reservations where channel_reservation_id = '<테스트 예약번호>'
);
delete from reservation_events where reservation_id = (
  select id from reservations where channel_reservation_id = '<테스트 예약번호>'
);
delete from reservations where channel_reservation_id = '<테스트 예약번호>';
```
