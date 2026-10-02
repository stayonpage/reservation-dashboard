-- 0027 검증 — 0026 이 이미 적용된 DB(운영 포함) 에서 실행.
-- assign_random_room 네 시나리오(정상 배정/재배정 멱등/취소된 예약 거부/배정 전 done
-- 재오픈)를 begin…rollback 으로 검증. 무변경.
-- 성공 시 'ALL PASSED' 한 행, 실패 시 ERROR: FAIL: <라벨>.

begin;

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
  v_pending_count int;
begin
  -- 시나리오 A: 정상 배정 → room_name 갱신 + 3채널(imweb 포함) block_tasks 생성.
  -- ingest 시점에 이미 naver/stayfolio 2건이 생겨 있으므로(아임웹 제외 규칙), assign이
  -- 추가하는 건 imweb 1건뿐이어도 총 3건이면 정상 — 이 단계만으로는 "assign이 몇 건 만들었는지"
  -- 못 가린다(시나리오 D가 그걸 가린다).
  v_res_id := _t_rand('R1');

  select count(*) into v_block_count from block_tasks where reservation_id = v_res_id;
  if v_block_count <> 2 then
    raise exception 'FAIL: %', 'A-pre: ingest 직후 block_tasks가 2건이 아님(실제 ' || v_block_count || ') — 가정이 깨짐, 시나리오 재검토 필요';
  end if;

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

  select count(*) into v_pending_count from block_tasks
   where reservation_id = v_res_id and status = 'pending';
  if v_pending_count <> 3 then
    raise exception 'FAIL: %', 'A: 배정 직후 pending이 3건이 아님(실제 ' || v_pending_count || ')';
  end if;

  if not exists (
    select 1 from reservation_events
     where reservation_id = v_res_id and type = 'room_assigned'
  ) then
    raise exception 'FAIL: %', 'A: room_assigned 이벤트가 안 남음';
  end if;

  -- 시나리오 B: 같은 예약 재배정(실수 정정) → block_tasks 중복 생성 안 됨(not exists로 멱등).
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

  -- 시나리오 D: 배정 "전"에 직원이 ingest-time naver/stayfolio 태스크를 먼저 체크해버린 경우.
  -- assign 호출 시 그 done 태스크들이 pending으로 재오픈돼야 한다(2026-10-02 전체 리뷰에서
  -- 발견된 오버부킹 버그의 회귀 가드).
  v_res_id := _t_rand('R3');

  update block_tasks set status = 'done', done_at = now()
   where reservation_id = v_res_id;

  select count(*) into v_pending_count from block_tasks
   where reservation_id = v_res_id and status = 'pending';
  if v_pending_count <> 0 then
    raise exception 'FAIL: %', 'D-pre: done 처리가 안 먹음';
  end if;

  perform assign_random_room(v_res_id, 'page8');

  select count(*) into v_block_count from block_tasks where reservation_id = v_res_id;
  if v_block_count <> 3 then
    raise exception 'FAIL: %', 'D: 배정 후 block_tasks가 3건이 아님(실제 ' || v_block_count || ')';
  end if;

  select count(*) into v_pending_count from block_tasks
   where reservation_id = v_res_id and status = 'pending';
  if v_pending_count <> 3 then
    raise exception 'FAIL: %', 'D: 배정 전 done 처리된 태스크가 재오픈 안 됨(pending ' || v_pending_count || '/3) — 오버부킹 위험';
  end if;
end $$;

drop function _t_rand(text);
drop function _t_ing_cancel(text);

select 'ALL PASSED — 0027 OK' as result;

rollback;
