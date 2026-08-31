-- 0023 v2 검증 시나리오. supabase db reset 후 실행.
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f scripts/verify-0023.sql
-- 주의: auth.uid() 는 psql 로컬 실행 시 NULL. supabase db reset 로 만든 로컬 스택에서 실행할 것.
-- 모든 `... as check, <bool>` 행은 `t` 를 기대한다.
\set ON_ERROR_STOP on
begin;

-- 헬퍼: ingest_reservation 호출 축약.
-- phone/opts/guest_request 는 뒤에 default 로 추가 — 기존 호출부(positional, named cancelled=>) 그대로 동작.
create or replace function _t_ing(cid text, ci date, co date, amt int default 150000,
                                  room text default 'page26', cancelled bool default false,
                                  phone text default '010-1', opts jsonb default '[]'::jsonb,
                                  guest_request text default null)
returns uuid language sql as $$
  select ingest_reservation('naver'::channel, cid, '홍길동', phone, room,
    ci, co, amt, opts, 'cash'::payment_method,
    'pending'::payment_status, jsonb_build_object('t', now()), cancelled, guest_request);
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

-- 3) 날짜 변경 → pending 1건(kind=change), 예약 본체 불변
select _t_ing('R1', date '2026-03-20', date '2026-03-21');
select 'change: pending=1(kind=change)?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending' and rc.kind='change';
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

-- 6) 변경 대기 중 취소 메일 → 같은 pending 행이 kind='cancel' 로 갈아끼워짐(v2: 즉시취소 아님)
select _t_ing('R1', date '2026-04-01', date '2026-04-02');           -- 날짜 변경 → pending kind=change
select 'change→cancel setup: pending kind=change?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending' and rc.kind='change';
select _t_ing('R1', date '2026-04-01', date '2026-04-02', cancelled => true);
select 'cancel queue: 예약 status 활성 유지(취소 아님)?' as check, status <> 'cancelled'
  from reservations where channel_reservation_id='R1';
select 'cancel queue: pending 1건 kind=cancel?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending' and rc.kind='cancel';
select 'cancel queue: cancel_source=channel_notification?' as check,
  bool_and(rc.cancel_source='channel_notification') from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='R1' and rc.status='pending' and rc.kind='cancel';

-- 7) 게스트하우스 stayfolio 제외 (§4 신규행)
select _t_ing('G1', date '2026-07-01', date '2026-07-02', room => '객실 서쪽 101');
select 'gh new: block_tasks=1 (imweb만)?' as check, count(*)=1 from block_tasks bt
  join reservations r on r.id=bt.reservation_id where r.channel_reservation_id='G1';
select 'gh new: 그 1건이 imweb?' as check, bool_and(bt.target_channel='imweb') from block_tasks bt
  join reservations r on r.id=bt.reservation_id where r.channel_reservation_id='G1';
select _t_ing('G2', date '2026-07-01', date '2026-07-02', room => 'page26');
select 'non-gh new: block_tasks=2 (imweb+stayfolio)?' as check, count(*)=2 from block_tasks bt
  join reservations r on r.id=bt.reservation_id where r.channel_reservation_id='G2';

-- 8) 게스트하우스 stayfolio 제외 (§6 confirm)
select _t_ing('G3', date '2026-07-10', date '2026-07-11', room => '남쪽방A');
select _t_ing('G3', date '2026-07-20', date '2026-07-21', room => '남쪽방A');   -- 변경 → pending
select confirm_reservation_change(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='G3' and rc.status='pending'));
select 'gh confirm: stayfolio block_task 없음?' as check, count(*)=0 from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='G3')
    and target_channel='stayfolio';
select 'gh confirm: imweb 새 날짜 block pending(7/20)?' as check, count(*)>=1 from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='G3')
    and target_channel='imweb' and action='block' and status='pending'
    and check_in=date '2026-07-20';

-- 9) null 금액 / null 전화 가드 (§4) — 값 못 뽑았을 때 "변경 아님"
select _t_ing('N1', date '2026-08-01', date '2026-08-02');
select _t_ing('N1', date '2026-08-01', date '2026-08-02', amt => NULL);
select 'null-amt: pending=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='N1' and rc.status='pending';
select _t_ing('N2', date '2026-08-05', date '2026-08-06');
select _t_ing('N2', date '2026-08-05', date '2026-08-06', phone => NULL);
select 'null-phone: pending=0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='N2' and rc.status='pending';

-- 10) 옵션 변경 (§4) → pending 생성, new_options 비어있지 않음
select _t_ing('O1', date '2026-09-01', date '2026-09-02');
select _t_ing('O1', date '2026-09-01', date '2026-09-02',
  opts => '[{"name":"조식","qty":2,"price":12000}]'::jsonb);
select 'opts change: pending=1?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='O1' and rc.status='pending';
select 'opts change: new_options 비어있지 않음?' as check,
  bool_and(rc.new_options <> '[]'::jsonb) from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='O1' and rc.status='pending';

-- ── RPC: confirm_reservation_change (kind='change') ──
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
select 'confirm: detected 이벤트(source=reservation_change)?' as check, count(*)=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='R2' and ev.type='detected'
    and ev.detail->>'source'='reservation_change';
select 'confirm: note 이벤트 존재?' as check, count(*)>=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='R2' and ev.type='note';

-- confirm_reservation_change 가드: kind<>'change' 큐엔 no-op (18번 뒤에서 재확인)

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
select 'keep: note 이벤트에 "기존 예약 유지" 포함?' as check, count(*)=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='R3' and ev.type='note'
    and ev.detail->>'note' like '%기존 예약 유지%';

-- ══ v2 시나리오 ══════════════════════════════════════════════════

-- 11) 취소 메일 → cancel 큐 (예약은 활성 유지)
select _t_ing('C1', date '2026-10-01', date '2026-10-03');            -- 신규(active, awaiting_deposit)
select _t_ing('C1', date '2026-10-01', date '2026-10-03', cancelled => true);
select 'C1 cancel queue: kind=cancel pending 1건?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='C1' and rc.status='pending' and rc.kind='cancel';
select 'C1 cancel queue: 예약 status 아직 활성(cancelled 아님)?' as check, status <> 'cancelled'
  from reservations where channel_reservation_id='C1';
select 'C1 cancel queue: cancel_review_queued note?' as check, count(*)>=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='C1' and ev.type='note'
    and ev.detail->>'source'='cancel_review_queued';

-- 12) cancel 확정 → confirm_cancel_review
select confirm_cancel_review(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='C1' and rc.status='pending' and rc.kind='cancel'));
select 'C1 confirm cancel: 예약 status=cancelled?' as check, status='cancelled'
  from reservations where channel_reservation_id='C1';
select 'C1 confirm cancel: 큐 confirmed?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='C1' and rc.status='confirmed' and rc.kind='cancel';
select 'C1 confirm cancel: pending/block block_tasks → skipped(0 남음)?' as check, count(*)=0
  from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='C1')
    and status='pending' and action='block';
select 'C1 confirm cancel: cancelled 이벤트(source=cancel_review)?' as check, count(*)=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='C1' and ev.type='cancelled'
    and ev.detail->>'source'='cancel_review';

-- 13) cancel 후 정상 재접수 → uncancel 큐 (예약은 cancelled 유지)
select _t_ing('C1', date '2026-10-01', date '2026-10-03');
select 'C1 uncancel queue: kind=uncancel pending 1건?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='C1' and rc.status='pending' and rc.kind='uncancel';
select 'C1 uncancel queue: 예약 아직 cancelled?' as check, status='cancelled'
  from reservations where channel_reservation_id='C1';
select 'C1 uncancel queue: uncancel_review_queued note?' as check, count(*)>=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='C1' and ev.type='note'
    and ev.detail->>'source'='uncancel_review_queued';

-- 14) uncancel 확정 → confirm_uncancel_review (헬퍼는 payment_status='pending' → status=awaiting_deposit 로 복구)
select confirm_uncancel_review(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='C1' and rc.status='pending' and rc.kind='uncancel'));
select 'C1 confirm uncancel: 예약 status 복구(awaiting_deposit)?' as check, status='awaiting_deposit'
  from reservations where channel_reservation_id='C1';
select 'C1 confirm uncancel: cancelled_at is null?' as check, cancelled_at is null
  from reservations where channel_reservation_id='C1';
select 'C1 confirm uncancel: 큐 confirmed?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='C1' and rc.status='confirmed' and rc.kind='uncancel';
select 'C1 confirm uncancel: 다른 채널 block pending 재생성(>=1)?' as check, count(*)>=1
  from block_tasks
  where reservation_id=(select id from reservations where channel_reservation_id='C1')
    and action='block' and status='pending';
select 'C1 confirm uncancel: detected 이벤트(source=uncancel_review)?' as check, count(*)=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='C1' and ev.type='detected'
    and ev.detail->>'source'='uncancel_review';

-- 15) 취소 대기 중 정상 재접수(같은 값) → cancel 큐 자동 withdrawn, 예약 활성 유지
select _t_ing('C2', date '2026-11-01', date '2026-11-02');            -- 신규
select _t_ing('C2', date '2026-11-01', date '2026-11-02', cancelled => true);   -- cancel 큐
select _t_ing('C2', date '2026-11-01', date '2026-11-02');            -- 정상 재접수(원복 신호)
select 'C2 auto-withdraw: cancel 큐 withdrawn?' as check, count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='C2' and rc.status='withdrawn' and rc.kind='cancel';
select 'C2 auto-withdraw: pending 0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='C2' and rc.status='pending';
select 'C2 auto-withdraw: 예약 활성 유지?' as check, status <> 'cancelled'
  from reservations where channel_reservation_id='C2';

-- 16) guest_request 저장/갱신 — 큐 생성 안 됨
select _t_ing('G9', date '2026-12-01', date '2026-12-02', guest_request => '늦은 체크인');
select 'G9: guest_request 저장?' as check, guest_request='늦은 체크인'
  from reservations where channel_reservation_id='G9';
select _t_ing('G9', date '2026-12-01', date '2026-12-02', guest_request => '반려동물 문의');
select 'G9: guest_request 갱신?' as check, guest_request='반려동물 문의'
  from reservations where channel_reservation_id='G9';
select 'G9: guest_request 재수신은 큐 생성 안 함?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='G9' and rc.status='pending';

-- 17) change 트리거 축소 — 이름만 다른 재수신 → pending 0, guest_name 즉시 갱신
select _t_ing('T1', date '2027-01-05', date '2027-01-06');            -- 신규(홍길동)
select ingest_reservation('naver'::channel, 'T1', '김철수', '010-1', 'page26',
  date '2027-01-05', date '2027-01-06', 150000, '[]'::jsonb, 'cash'::payment_method,
  'pending'::payment_status, jsonb_build_object('t', now()), false, null);
select 'T1 name-only: pending 0?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='T1' and rc.status='pending';
select 'T1 name-only: guest_name 즉시 갱신(김철수)?' as check, guest_name='김철수'
  from reservations where channel_reservation_id='T1';

-- 18) enqueue_ics_cancel_review — 활성 예약에 큐 생성, 중복 호출 멱등
select _t_ing('S1', date '2027-02-10', date '2027-02-11');            -- 신규(active)
select enqueue_ics_cancel_review((select id from reservations where channel_reservation_id='S1'));
select enqueue_ics_cancel_review((select id from reservations where channel_reservation_id='S1'));
select 'S1 enqueue: kind=cancel / cancel_source=stayfolio_ics_missing pending 1건(중복 아님)?' as check,
  count(*)=1 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='S1' and rc.status='pending'
    and rc.kind='cancel' and rc.cancel_source='stayfolio_ics_missing';
select 'S1 enqueue: cancel_review_queued note(stayfolio_ics_missing)?' as check, count(*)>=1
  from reservation_events ev join reservations r on r.id=ev.reservation_id
  where r.channel_reservation_id='S1' and ev.type='note'
    and ev.detail->>'cancel_source'='stayfolio_ics_missing';
-- 취소된 예약엔 no-op
select _t_ing('S2', date '2027-03-10', date '2027-03-11');
select _t_ing('S2', date '2027-03-10', date '2027-03-11', cancelled => true);
select confirm_cancel_review(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='S2' and rc.status='pending' and rc.kind='cancel'));
select enqueue_ics_cancel_review((select id from reservations where channel_reservation_id='S2'));
select 'S2 enqueue: 취소된 예약엔 새 pending 없음?' as check, count(*)=0 from reservation_changes rc
  join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='S2' and rc.status='pending';

-- 19) confirm_reservation_change 는 kind<>'change' 큐에 no-op
select _t_ing('K1', date '2027-04-10', date '2027-04-11');
select _t_ing('K1', date '2027-04-10', date '2027-04-11', cancelled => true);   -- kind=cancel pending
select confirm_reservation_change(
  (select rc.id from reservation_changes rc join reservations r on r.id=rc.reservation_id
    where r.channel_reservation_id='K1' and rc.status='pending'));
select 'K1: confirm_reservation_change 는 cancel 큐에 무반응(pending 유지)?' as check, count(*)=1
  from reservation_changes rc join reservations r on r.id=rc.reservation_id
  where r.channel_reservation_id='K1' and rc.status='pending' and rc.kind='cancel';
select 'K1: 예약 여전히 활성?' as check, status <> 'cancelled'
  from reservations where channel_reservation_id='K1';

drop function _t_ing(text,date,date,int,text,bool,text,jsonb,text);
rollback;
