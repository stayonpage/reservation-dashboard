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

  -- 3채널 전부 막기 태스크 생성. 멱등: 이미 있는 (reservation_id, target_channel) 조합은
  -- where not exists로 걸러서 재배정으로 또 호출돼도 중복 insert 안 됨.
  -- (운영 DB의 block_tasks에는 (reservation_id, target_channel) unique 제약이 실제로는
  -- 없어서 — 0001_init.sql 정의와 실제 스키마가 어긋남, 2026-10-02 확인 — on conflict를
  -- 못 쓴다. 제약을 새로 거는 대신 함수를 제약-불필요 방식으로 작성.)
  insert into block_tasks (reservation_id, target_channel, check_in, check_out)
    select p_reservation_id, c, v_check_in, v_check_out
      from unnest(enum_range(null::channel)) as c
     where not exists (
       select 1 from block_tasks bt
        where bt.reservation_id = p_reservation_id
          and bt.target_channel = c
     );

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
