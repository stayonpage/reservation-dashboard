-- 0024 검증 — 0023 이 이미 적용된 DB(운영 포함) 에서 실행.
-- 0024 적용 + uncancel 두 시나리오(날짜 바뀜 / 안 바뀜)를 begin…rollback 으로 검증. 무변경.
-- 성공 시 'ALL PASSED' 한 행, 실패 시 ERROR: FAIL: <라벨>.

begin;

-- 0024 본문
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
    prev_check_in  = case when c.new_check_in  is distinct from c.prev_check_in
                         then c.prev_check_in  else null end,
    prev_check_out = case when c.new_check_out is distinct from c.prev_check_out
                         then c.prev_check_out else null end,
    cancelled_by = null, cancelled_at = null,
    deposit_confirmed_by = null, deposit_confirmed_at = null,
    confirmed_by = null, confirmed_at = null
  where id = c.reservation_id;
  update block_tasks set status='skipped'
   where reservation_id=c.reservation_id and status='pending' and action='unblock';
  insert into block_tasks (reservation_id, target_channel, check_in, check_out, action, status)
    select c.reservation_id, ch2, c.new_check_in, c.new_check_out, 'block', 'pending'
    from unnest(enum_range(null::channel)) as ch2
    where ch2 <> r.channel and not (v_is_guesthouse and ch2 = 'stayfolio'::channel);
  insert into reservation_events (reservation_id, actor, type, detail)
    values (c.reservation_id, v_uid, 'detected', jsonb_build_object('source','uncancel_review'));
end; $$;

-- 헬퍼
create or replace function _t_ing2(cid text, ci date, co date, cancelled bool default false)
returns uuid language sql as $$
  select ingest_reservation('naver'::channel, cid, '홍길동', '010-1', 'page26',
    ci, co, 150000, '[]'::jsonb, 'cash'::payment_method,
    'pending'::payment_status, jsonb_build_object('t', now()), cancelled, null);
$$;

do $$
begin
  -- 시나리오 A: 취소 → 다른 날짜로 재접수 → 되살리기 확정 → prev_check_in = 옛 날짜
  perform _t_ing2('U1', date '2026-10-01', date '2026-10-03');
  perform _t_ing2('U1', date '2026-10-01', date '2026-10-03', true);
  perform confirm_cancel_review((select rc.id from reservation_changes rc
    join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='U1' and rc.status='pending' and rc.kind='cancel'));
  perform _t_ing2('U1', date '2026-11-05', date '2026-11-07');   -- 다른 날짜로 재접수 → uncancel 큐
  perform confirm_uncancel_review((select rc.id from reservation_changes rc
    join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='U1' and rc.status='pending' and rc.kind='uncancel'));
  if not coalesce((select check_in=date '2026-11-05' and prev_check_in=date '2026-10-01'
                   and prev_check_out=date '2026-10-03'
                   from reservations where channel_reservation_id='U1'), false)
  then raise exception 'FAIL: %', 'A: 날짜 바뀐 되살리기 → prev_check_in/out = 옛 날짜'; end if;

  -- 시나리오 B: 취소 → 같은 날짜로 재접수 → 되살리기 확정 → prev_check_in IS NULL (카드 줄 안 뜸)
  perform _t_ing2('U2', date '2026-12-01', date '2026-12-03');
  perform _t_ing2('U2', date '2026-12-01', date '2026-12-03', true);
  perform confirm_cancel_review((select rc.id from reservation_changes rc
    join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='U2' and rc.status='pending' and rc.kind='cancel'));
  perform _t_ing2('U2', date '2026-12-01', date '2026-12-03');   -- 같은 날짜 재접수 → uncancel 큐
  perform confirm_uncancel_review((select rc.id from reservation_changes rc
    join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='U2' and rc.status='pending' and rc.kind='uncancel'));
  if not coalesce((select prev_check_in is null and prev_check_out is null
                   from reservations where channel_reservation_id='U2'), false)
  then raise exception 'FAIL: %', 'B: 같은 날짜 되살리기 → prev_check_in/out NULL'; end if;
end $$;

drop function _t_ing2(text,date,date,bool);

select 'ALL PASSED — 0024 OK' as result;

rollback;
