-- 0023 검증 시나리오. supabase db reset 후 실행.
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f scripts/verify-0023.sql
\set ON_ERROR_STOP on
begin;

-- 헬퍼: ingest_reservation 호출 축약
create or replace function _t_ing(cid text, ci date, co date, amt int default 150000,
                                  room text default 'page26', cancelled bool default false)
returns uuid language sql as $$
  select ingest_reservation('naver'::channel, cid, '홍길동', '010-1', room,
    ci, co, amt, '[]'::jsonb, 'cash'::payment_method,
    'pending'::payment_status, jsonb_build_object('t', now()), cancelled);
$$;

-- 1) 신규
select _t_ing('R1', date '2026-03-09', date '2026-03-10');
select 'new: reservations=1?' as check, count(*)=1 from reservations where channel_reservation_id='R1';
select 'new: block_tasks(naver 제외 2)?' as check, count(*)=2 from block_tasks bt
  join reservations r on r.id=bt.reservation_id where r.channel_reservation_id='R1';
select 'new: changes=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id where r.channel_reservation_id='R1';

-- 2) 동일 재수신 → no-op (changes 0)
select _t_ing('R1', date '2026-03-09', date '2026-03-10');
select 'resend same: changes still 0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id where r.channel_reservation_id='R1';

-- 3) 날짜 변경 → pending 1건, 예약 본체 불변
select _t_ing('R1', date '2026-03-20', date '2026-03-21');
select 'change: pending=1?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';
select 'change: 예약 날짜 그대로 3/9?' as check, check_in = date '2026-03-09'
  from reservations where channel_reservation_id='R1';
select 'change: updated 이벤트?' as check, count(*)=1 from reservation_events ev
  join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='R1' and ev.type='updated';

-- 4) 또 다른 날짜 → 같은 pending 행 갱신(여전히 1건), prev는 3/9 유지
select _t_ing('R1', date '2026-03-25', date '2026-03-26');
select 'change2: pending 여전히 1?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';
select 'change2: new_check_in=3/25 & prev_check_in=3/9?' as check,
  bool_and(rc.new_check_in=date '2026-03-25' and rc.prev_check_in=date '2026-03-09')
  from reservation_changes rc join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';

-- 5) 원래 값으로 되돌림 → pending withdrawn
select _t_ing('R1', date '2026-03-09', date '2026-03-10');
select 'revert: pending=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';
select 'revert: withdrawn=1?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='withdrawn';

-- 6) 취소 메일: pending이 있어도 함께 withdrawn
select _t_ing('R1', date '2026-04-01', date '2026-04-02');           -- pending 재생성
select _t_ing('R1', date '2026-04-01', date '2026-04-02', cancelled => true);
select 'cancel: 예약 status=cancelled?' as check, status='cancelled'
  from reservations where channel_reservation_id='R1';
select 'cancel: pending=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending';

-- ── RPC: confirm ──
select _t_ing('R2', date '2026-05-10', date '2026-05-11');            -- 신규
-- naver 예약이므로 stayfolio/imweb 막기 2건 생성됨. 하나를 "막음(done)"으로.
update block_tasks set status='done', action='block'
 where reservation_id=(select id from reservations where channel_reservation_id='R2')
   and target_channel='imweb';
select _t_ing('R2', date '2026-05-20', date '2026-05-21');            -- 변경 → pending
select confirm_reservation_change(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='R2' and rc.status='pending'));

select 'confirm: 예약 날짜=5/20?' as check, check_in=date '2026-05-20'
  from reservations where channel_reservation_id='R2';
select 'confirm: prev_check_in=5/10?' as check, prev_check_in=date '2026-05-10'
  from reservations where channel_reservation_id='R2';
select 'confirm: 큐 confirmed?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R2' and rc.status='confirmed';
select 'confirm: imweb 다시열기(unblock,pending)?' as check, count(*)=1 from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='R2')
    and target_channel='imweb' and action='unblock' and status='pending';
select 'confirm: 새 날짜 block pending 존재(imweb 5/20)?' as check, count(*)>=1 from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='R2')
    and target_channel='imweb' and action='block' and status='pending'
    and check_in=date '2026-05-20';

-- ── RPC: keep ──
select _t_ing('R3', date '2026-06-10', date '2026-06-11');
select _t_ing('R3', date '2026-06-20', date '2026-06-21');            -- 변경 → pending
select keep_reservation_change(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='R3' and rc.status='pending'));
select 'keep: 큐 kept?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R3' and rc.status='kept';
select 'keep: 예약 날짜 그대로 6/10?' as check, check_in=date '2026-06-10'
  from reservations where channel_reservation_id='R3';

drop function _t_ing(text,date,date,int,text,bool);
rollback;
