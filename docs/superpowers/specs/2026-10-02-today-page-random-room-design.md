# "오늘의 페이지" 랜덤객실 — 실제 객실 배정 + 3채널 차단 — 설계

- 작성일: 2026-10-02
- 대상 저장소: `숙박통합사이트` (sukbak-integration)
- 관련 파일: `lib/actions.ts`, `lib/rooms.ts`, `components/ReservationList.tsx`, `components/BlockWorklist.tsx`(수정 없음, 재사용), `supabase/migrations/0026_*.sql`, `0027_*.sql`

## 1. 배경

스테이온페이지(아임웹)에 평일(일~목) 전용 가상 객실 상품 **"오늘의 페이지"**를 등록함(2026-10-02, 숨김 상태로 생성 완료). 고객은 이 상품으로 예약하고, 체크인 12:00·체크아웃 12:00(얼리인·레이트아웃)을 안내받는다. 가격은 실제 4개 객실(page26/452/8/127)과 동일.

직원이 예약 확인 시 실제 어느 객실로 보낼지 정해서 배정해야 하며, 이 배정은 **풀링 유연성**(사장님이 상황 보고 비는 객실에 넣기)이 목적이므로 가상 상품을 고객이 직접 선택하는 방식 대신 유지한다.

핵심 제약(조사로 확인됨):
- 아임웹 Open API는 예약(객실) 모듈을 지원하지 않음 — 외부 자동화 불가.
- 아임웹 예약 주문 자체를 다른 상품으로 "이동"하는 기능 없음(취소+재생성만 가능) — 그래서 아임웹 쪽 주문은 그대로 "오늘의 페이지" 상품에 둔 채, 실제 배정 객실은 **숙박앱 내부 데이터에서만** 관리한다.
- "오늘의 페이지"(가상 상품)와 실제 객실(page26 등)은 아임웹에서 서로 다른 상품 = 서로 다른 캘린더. 아임웹 자체도 실제 배정 객실 날짜를 수동으로 막아야 함(보통은 들어온 채널=아임웹은 자동으로 막히니 제외하는데, 이번 건 예외).
- 네이버·스테이폴리오도 각각 수동으로 막아야 함(기존과 동일).

## 2. 목표

1. 예약확인 큐 화면에서 "오늘의 페이지"로 들어온 예약에 실제 객실(page26/452/8/127) 선택 드롭다운을 보여준다.
2. 직원이 객실을 선택하고 확정하면:
   - 그 예약의 `room_name`을 선택한 실제 객실로 바꾼다(고객정보·날짜·금액 등 나머지 데이터는 그대로 유지).
   - 기존 `block_tasks` 워크리스트(막아야 할 채널)에 **아임웹·네이버·스테이폴리오 3채널 전부** 새 할 일이 뜨게 한다(평소엔 들어온 채널 제외 2채널만 뜨는데, 이번엔 3채널 — 이유는 위 1절).
3. 기존 `BlockWorklist` 컴포넌트는 **수정 없이 재사용** — `reservation_id`로 조인해서 보여주는 구조라 새 할 일도 자동으로 올바른 객실명·투숙객명을 보여준다.

## 3. 상수 정의 — `lib/rooms.ts`

```ts
export const TODAY_PAGE_PRODUCT_NAME = '오늘의 페이지';
```

아임웹 주문 메일 파싱 결과(`room_name`)가 이 문자열과 정확히 일치하면 "배정 대기" 상태로 간주한다. 배정 전 상태 전용 컬럼은 추가하지 않는다 — `room_name === TODAY_PAGE_PRODUCT_NAME`이고 `status <> 'cancelled'`이면 배정 대기, 배정하면 `room_name`이 실제 객실명으로 바뀌므로 판별식이 자동으로 꺼진다.

`ROOMS` 배열(캘린더 컬럼)에는 추가하지 않는다 — "오늘의 페이지"는 배정 전 임시 상태일 뿐, 캘린더에 별도 컬럼으로 보일 필요가 없다(배정되면 실제 객실 컬럼 아래 표시됨).

## 4. DB — 마이그레이션 `0026_add_room_assigned_event_type.sql` + `0027_assign_random_room.sql`

직원이 대시보드에서 로그인 상태로 직접 누르는 액션이라 `toggle_block_task`/`confirm_deposit`(0003)과 같은 패턴 — **`security invoker`** + `auth.uid()`(definer 아님, `set search_path` 고정도 불필요 — 0025는 definer 함수에만 적용된 보안조치).

```sql
create or replace function assign_random_room(
  p_reservation_id uuid,
  p_room_name text  -- 순수 객실 코드만, 예: 'page26' (책 제목 안 붙임 — 6절 참고)
)
returns void
language plpgsql
security invoker
as $$
declare
  v_prev_room_name text;
  v_check_in date;
  v_check_out date;
  v_channel channel;
  v_status reservations.status%type;
  v_uid uuid := auth.uid();
begin
  select room_name, check_in, check_out, channel, status
    into v_prev_room_name, v_check_in, v_check_out, v_channel, v_status
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

  -- 3채널 전부 막기 태스크 생성 (오늘의 페이지 ≠ 실제 객실 캘린더라서 아임웹도 포함).
  -- 멱등: 같은 예약에 재배정이 들어와도 (reservation_id, target_channel) unique라 중복 안 생김.
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

- `reservation_events.type`은 `event_type` enum이고 현재 `'room_assigned'` 값이 없다. `0006`/`0008`의 전례를 그대로 따라 이 마이그레이션 맨 앞에 추가한다:
  ```sql
  alter type event_type add value if not exists 'room_assigned';
  ```
  (주의: `alter type ... add value`는 같은 트랜잭션 내에서 그 값을 바로 사용할 수 없는 Postgres 제약이 있으므로, 이 문을 **별도 마이그레이션 파일**(`0026_add_room_assigned_event_type.sql`)로 분리하고 `assign_random_room` 함수 정의는 그다음 파일(`0027_assign_random_room.sql`)에 둔다.)
- 재배정(배정 실수 정정) 시나리오: 같은 RPC를 다른 `p_room_name`으로 다시 호출하면 `room_name`만 갱신되고, 새 room에 대한 block_tasks가 추가로 생긴다. 이전에 배정했던(잘못된) 객실에 대한 block_tasks 취소/재오픈은 범위 밖(수동으로 처리 — 흔치 않은 케이스라 자동화하지 않음).

## 5. 서버 액션 — `lib/actions.ts`

```ts
export async function assignRandomRoom(
  reservationId: string,
  roomName: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('assign_random_room', {
    p_reservation_id: reservationId,
    p_room_name: roomName,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}
```

기존 액션들과 동일한 패턴(RPC 호출 + revalidatePath).

## 6. UI — `components/ReservationList.tsx`

카드 렌더링 시 `r.room_name === TODAY_PAGE_PRODUCT_NAME && r.status !== 'cancelled'`이면 기존 메타 정보 아래에 객실 선택 드롭다운 + "배정 확정" 버튼을 추가로 보여준다.

- 드롭다운 옵션: `ROOMS`에서 `code.startsWith('page')`인 4개(= page26/452/8/127), 표시 라벨은 `ROOMS`의 `label`("페이지26" 등).
- **배정값은 책 제목을 뺀 순수 코드(`'page26'` 등)만 저장한다.** 실제 아임웹 주문의 `room_name`은 `'page26 - 분홍 마음을 울리는 시인선'`처럼 책 제목이 붙지만, 이 책 제목은 전시 중인 책이 바뀌면 같이 바뀌는 값이라(테스트 픽스처에도 같은 page26인데 제목이 서로 다른 샘플이 존재) 하드코딩하면 금방 오래된 값이 된다. `roomCodeOf()`는 `startsWith(code)` + 다음 글자가 숫자가 아님만 확인하므로 `'page26'` 단독 문자열도 정상적으로 `page26`으로 매칭된다. `displayRoomName()`은 page 계열은 원문을 그대로 보여주므로, 배정 후 이 카드엔 책 제목 없이 `page26`으로만 표시된다(관리자 내부 화면이라 문제 없음).
- 확정 버튼 클릭 → `assignRandomRoom(r.id, selectedRoomCode)` 호출, 로딩 중 비활성화, 에러 시 alert(기존 다른 확정 버튼들의 에러 처리 패턴과 동일하게).
- 배정 완료 후에는 `room_name`이 바뀌므로 이 UI는 자동으로 사라지고 일반 예약 카드로 보인다(추가 상태 관리 불필요).

## 7. 테스트

- `assign_random_room` RPC: `scripts/verify-0023-standalone.sql` 패턴을 따라 `0026` 전용 검증 스크립트 작성 — 배정 시 room_name 갱신, block_tasks 3건 생성(imweb 포함), 재배정 시 중복 생성 안 됨, 취소된 예약엔 에러.
- UI 쪽은 기존 컴포넌트 테스트가 있다면(`*.test.tsx` 확인 필요) 드롭다운 노출 조건 테스트 추가.

## 8. 범위 밖

- "오늘의 페이지" 상품의 금·토·공휴일 수동 차단 운영(아임웹 예약현황관리에서 매주 반복) — 사장님이 직접 운영, 자동화 대상 아님.
- 아임웹 Open API 연동 전반 — 아임웹이 예약모듈 API를 제공하지 않아 애초에 불가능.
- 배정 실수 정정 시 이전 block_tasks 취소 자동화 — 드문 케이스라 수동 처리.
