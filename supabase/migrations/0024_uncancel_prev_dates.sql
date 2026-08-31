-- confirm_uncancel_review 가 되살린 예약에 "이전 날짜에서 변경" 정보를 남기도록 보강.
--
-- 미룬 Minor #1 (2026-08-29 v2 opus 최종 리뷰). 0023 §8 대비 딱 두 줄 추가 —
-- reservations.prev_check_in / prev_check_out 를 채운다. 단 날짜가 실제로 바뀐 경우에만:
-- 같은 날짜로 재예약(취소 철회)이면 카드(components/ReservationList.tsx:99, RoomCalendar.tsx:276)에
-- 불필요한 "이전 …에서 변경" 줄이 뜨지 않도록 그때는 null 로 둔다.
-- (confirm_reservation_change(§6)는 kind='change' 라 날짜/객실/옵션 중 하나는 반드시 다르므로 무조건 채움.
--  uncancel 은 같은 값 재접수도 흔해서 가드가 필요하다.)

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
   where id=p_change_id and status='pending' and kind = 'uncancel';
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
    -- 새로 추가: 날짜가 바뀐 경우에만 직전 날짜 기록(안 바뀌면 null → 카드에 줄 안 뜸)
    prev_check_in  = case when c.new_check_in  is distinct from c.prev_check_in
                         then c.prev_check_in  else null end,
    prev_check_out = case when c.new_check_out is distinct from c.prev_check_out
                         then c.prev_check_out else null end,
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
