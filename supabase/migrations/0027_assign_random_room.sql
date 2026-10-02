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

  -- "오늘의 페이지"는 아임웹 접수 시점에 ingest_reservation이 이미 나머지 2채널(네이버·
  -- 스테이폴리오) block_tasks를 만들어 둔 상태다(들어온 채널=아임웹 제외 규칙, 0002 §64-67).
  -- 배정 전에 직원이 그 2건을 먼저 체크해버리면(아직 "오늘의 페이지"라고만 뜨니 헷갈려서
  -- 할 수 있음) 아래 insert가 이미 존재하는 (reservation_id, target_channel)로 보고 건너뛰어
  -- 다시 안 만든다 — 실제 배정 객실이 네이버·스테이폴리오에 영영 안 막히는 사고가 난다
  -- (2026-10-02 전체 리뷰에서 발견). 그래서 insert 전에 이 예약의 done 상태 block 태스크를
  -- 전부 pending으로 되돌린다 — 재배정(실수 정정) 때도 같은 이유로 안전하다.
  update block_tasks
     set status = 'pending', done_by = null, done_at = null
   where reservation_id = p_reservation_id
     and action = 'block'
     and status = 'done'
     and check_in = v_check_in
     and check_out = v_check_out;

  -- 3채널 전부 막기 태스크 보장. 멱등: 이미 있는 (reservation_id, target_channel) 조합은
  -- where not exists로 걸러서 재배정으로 또 호출돼도 중복 insert 안 됨.
  -- (운영 DB의 block_tasks에는 (reservation_id, target_channel) unique 제약이 없다 —
  -- 0001_init.sql 정의와 달리 0023 §3에서 의도적으로 제거됨: 변경 확정 시 같은 채널에
  -- "옛 날짜 다시 열기"와 "새 날짜 막기"가 동시에 존재해야 하기 때문. 그래서 on conflict를
  -- 못 쓰고 where not exists로 작성.)
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
