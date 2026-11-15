-- 직원이 "손님이 네이버에서 날짜를 바꿨다"를 대시보드에 직접 접수하는 RPC.
--
-- 배경(2026-11-14 은*은 건): 네이버는 예약 변경에 대해 메일을 보내지 않고 스마트플레이스 앱
-- 푸시로만 알린다 → ingest 경로로는 변경을 감지할 수 없다. 그래서 직원이 새 날짜를 입력하면
-- 기존 변경 확인 큐(0023/0024)를 그대로 태워 즉시 확정한다(새 반영 로직을 만들지 않는다).
--   · 정상 예약      → reservation_changes(kind='change')   + confirm_reservation_change
--   · 이미 취소된 예약 → reservation_changes(kind='uncancel') + confirm_uncancel_review
-- 반영 내용(예약 날짜 갱신, 옛 날짜 unblock·새 날짜 block 태스크, prev_check_in/out, 입금확인 초기화)은
-- 두 확정 함수가 하는 일 그대로다.
--
-- ⚠️ 배포 순서: 앱 배포보다 먼저 적용. (없는 RPC 를 호출하면 버튼만 실패, 대시보드 렌더에는 영향 없음)

create or replace function staff_change_dates(
  p_reservation_id uuid,
  p_new_check_in   date,
  p_new_check_out  date
) returns void
language plpgsql
security invoker
as $$
declare
  r        reservations%rowtype;
  v_kind   text;
  v_id     uuid;
  v_ok     boolean;
begin
  if p_new_check_in is null or p_new_check_out is null then
    raise exception '체크인·체크아웃 날짜가 필요합니다';
  end if;
  if p_new_check_out <= p_new_check_in then
    raise exception '체크아웃은 체크인보다 늦어야 합니다';
  end if;

  select * into r from reservations where id = p_reservation_id;
  if not found then
    raise exception '예약을 찾을 수 없습니다';
  end if;
  if r.check_in = p_new_check_in and r.check_out = p_new_check_out then
    raise exception '현재와 같은 날짜입니다';
  end if;

  v_kind := case when r.status = 'cancelled' then 'uncancel' else 'change' end;

  -- 열려 있는 검토 큐 항목(변경/취소/되살리기)은 이 접수로 대체한다(예약당 pending 1건 제약).
  update reservation_changes set status = 'withdrawn'
   where reservation_id = p_reservation_id and status = 'pending';

  insert into reservation_changes (
    reservation_id, kind,
    prev_check_in, prev_check_out, prev_room_name, prev_amount, prev_guest_name, prev_options,
    new_guest_name, new_guest_phone, new_room_name, new_check_in, new_check_out,
    new_amount, new_options, new_payment_method, new_payment_status
  ) values (
    r.id, v_kind,
    r.check_in, r.check_out, r.room_name, r.amount, r.guest_name, r.options,
    r.guest_name, r.guest_phone, r.room_name, p_new_check_in, p_new_check_out,
    r.amount, r.options, r.payment_method, r.payment_status
  ) returning id into v_id;

  if v_kind = 'change' then
    perform confirm_reservation_change(v_id);
  else
    perform confirm_uncancel_review(v_id);
  end if;

  -- 확정 함수는 조건이 안 맞으면 조용히 return 하므로 실제 반영을 확인한다.
  select (check_in = p_new_check_in and check_out = p_new_check_out) into v_ok
    from reservations where id = p_reservation_id;
  if not coalesce(v_ok, false) then
    raise exception '날짜 변경이 반영되지 않았습니다';
  end if;
end;
$$;
grant execute on function staff_change_dates(uuid, date, date) to authenticated;
