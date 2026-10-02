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

-- 헬퍼: 오늘의 페이지로 예약 하나 접수 후 바로 취소 상태로
create or replace function _t_ing_cancel(cid text)
returns uuid language sql as $$
  select ingest_reservation('imweb'::channel, cid, '김철수', '010-2', '오늘의 페이지',
    date '2026-11-10', date '2026-11-11', 190000, '[]'::jsonb, 'card'::payment_method,
    'paid'::payment_status, jsonb_build_object('t', now()), true, null);
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
drop function _t_ing_cancel(text);

select 'ALL PASSED — 0027 OK' as result;

rollback;
