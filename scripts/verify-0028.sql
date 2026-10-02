-- 0028 검증 — 0027이 이미 적용된 DB(운영 포함)에서 실행.
-- "오늘의 페이지" 배정 후 재수신 시 가짜 변경요청이 안 생기는지 확인. begin…rollback. 무변경.
-- 성공 시 'ALL PASSED' 한 행, 실패 시 ERROR: FAIL: <라벨>.

begin;

do $$
declare
  v_res_id uuid;
  v_room_name text;
  v_pending_change_count int;
begin
  -- 접수 → 배정(page26) → 같은 주문 메일 재수신(아임웹은 항상 '오늘의 페이지'로 보냄)
  v_res_id := ingest_reservation('imweb'::channel, 'E1', '홍길동', '010-1', '오늘의 페이지',
    date '2026-12-02', date '2026-12-03', 190000, '[]'::jsonb, 'card'::payment_method,
    'paid'::payment_status, jsonb_build_object('t', now()), false, null);

  perform assign_random_room(v_res_id, 'page26');

  -- 재수신: 날짜·옵션·금액 전부 동일, room_name만 원래 상품명 '오늘의 페이지'로 다시 옴.
  perform ingest_reservation('imweb'::channel, 'E1', '홍길동', '010-1', '오늘의 페이지',
    date '2026-12-02', date '2026-12-03', 190000, '[]'::jsonb, 'card'::payment_method,
    'paid'::payment_status, jsonb_build_object('t', now(), 'resend', true), false, null);

  select room_name into v_room_name from reservations where id = v_res_id;
  if v_room_name <> 'page26' then
    raise exception 'FAIL: %', 'E: 재수신 후 room_name이 page26에서 바뀜(실제 ' || v_room_name || ')';
  end if;

  select count(*) into v_pending_change_count
    from reservation_changes where reservation_id = v_res_id and status = 'pending';
  if v_pending_change_count <> 0 then
    raise exception 'FAIL: %', 'E: 재수신으로 가짜 변경요청이 큐에 쌓임';
  end if;

  -- 진짜 날짜 변경은 여전히 정상적으로 큐에 쌓여야 한다(회귀 가드).
  perform ingest_reservation('imweb'::channel, 'E1', '홍길동', '010-1', '오늘의 페이지',
    date '2026-12-05', date '2026-12-06', 190000, '[]'::jsonb, 'card'::payment_method,
    'paid'::payment_status, jsonb_build_object('t', now(), 'date_change', true), false, null);

  select count(*) into v_pending_change_count
    from reservation_changes
   where reservation_id = v_res_id and status = 'pending' and new_check_in = date '2026-12-05';
  if v_pending_change_count <> 1 then
    raise exception 'FAIL: %', 'E: 진짜 날짜 변경이 큐에 안 쌓임(회귀)';
  end if;

  -- 그 변경요청의 new_room_name은 '오늘의 페이지'가 아니라 기존 배정값(page26)이어야 한다
  -- (아니면 변경 확정 시 room_name이 '오늘의 페이지'로 되돌아감).
  if not exists (
    select 1 from reservation_changes
     where reservation_id = v_res_id and status = 'pending' and new_room_name = 'page26'
  ) then
    raise exception 'FAIL: %', 'E: 변경요청의 new_room_name이 page26으로 안 잡힘(아임웹 원문이 새어들어옴)';
  end if;
end $$;

select 'ALL PASSED — 0028 OK' as result;

rollback;
