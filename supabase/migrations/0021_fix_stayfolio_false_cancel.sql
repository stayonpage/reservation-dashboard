-- 2026-07-25 실사고 데이터 복구: 최은수(스테이폴리오, page26, 7/25~7/26) 예약이 자동 대사
-- (reconcile-stayfolio-ics)에 의해 취소로 오처리됨.
--
-- 원인: 스테이폴리오 ICS 캘린더는 한국시간 자정이 되는 순간 그날 체크아웃하는 예약을
-- 캘린더에서 지워버리는데(취소가 아니라 "더 이상 미래 날짜가 아니라서"), 우리 쪽 대사
-- 대상 필터는 UTC 자정 기준 "오늘"을 써서 한국시간 00:00~09:00(=UTC 전날 15:00~24:00)
-- 사이에 도는 대사 잡이 체크아웃 당일 예약을 걸러내지 못했다. 그 결과 2026-07-25
-- 15:00:01Z(=한국시간 정확히 00:00:01, 즉 대사 잡이 자정 이후 처음 돈 순간)에
-- cancel_reservation이 "ICS에서 사라짐"으로 잘못 판단해 정상 예약을 취소 처리함
-- (reservation_events.id=400, reason='stayfolio_ics_missing').
--
-- 코드 쪽 재발 방지는 lib/mail/reconcile-stayfolio-ics.ts에서 이미 수정(한국시간 기준
-- "오늘" 사용 + 체크아웃 당일 예약은 대사 대상에서 제외). 이 마이그레이션은 그 버그로
-- 잘못 취소된 이 한 건의 데이터만 원상복구한다 — reservation_events의 직전 상태
-- (id=173 'detected', payment_status='paid' → status='confirmed')를 근거로 복원.

update reservations
   set status = 'confirmed',
       cancelled_at = null
 where id = 'b10493f9-37c7-464b-977a-f5049f9db48e'
   and status = 'cancelled'
   and cancelled_at = '2026-07-25T15:00:01.693786+00:00';

-- 취소 처리 때 자동취소 함수가 "다시 열기"로 되돌려놓은 block_tasks 2건(네이버·아임웹)도
-- 원래 상태(이미 막아놓음=done, action=block)로 복구 — 실제로는 막아둔 채 계속 유효한
-- 예약이라 다시 열 필요가 없다.
update block_tasks
   set status = 'done',
       action = 'block'
 where id in (
   'fd3477a6-6c4d-4705-b9a4-09b7cdf087dd',
   '6b6a3c2b-8eab-4779-8f86-5701415467e5'
 )
   and status = 'pending'
   and action = 'unblock';

insert into reservation_events (reservation_id, actor, type, detail)
values (
  'b10493f9-37c7-464b-977a-f5049f9db48e',
  null,
  'note',
  jsonb_build_object(
    'note', '스테이폴리오 ICS 재대사 오탐(체크아웃일 한국시간 자정 경계)으로 인한 자동취소 오처리를 확인 후 수동 복구함',
    'corrects_event_id', 400
  )
);
