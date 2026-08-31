-- 7월 백필(2026-08-26) 중 잘못 채워진 데이터 정정: 김벼리님 스테이폴리오 예약(page26,
-- 7/29~7/30)은 운영자 확인 결과 실제로는 취소된 건이었다.
--
-- 왜 자동으로 안 잡혔나: 이 예약은 스테이폴리오 메일에 진짜 예약번호가 없어서
-- (stayfolio-email-enrich.ts가 ICS 피드에서 실제 번호를 찾아 보강하는데, 이미 지난 날짜라
-- ICS엔 그 밤이 안 남아 있어 매칭 실패) 합성키(guest_email|...)로 저장됐다. reconcile-
-- stayfolio-ics.ts는 "합성키 예약은 ICS와 대조할 수 없어 애초에 제외"하므로, 이 예약은
-- 자동 취소 감지 대상에서 원천적으로 빠져 있었다(진짜 번호가 있는 예약만 대사 가능).
--
-- 같은 손님·같은 날짜의 아임웹 예약(이미 cancelled로 정상 기록됨)과 짝을 이루는 건으로,
-- 두 채널 다 취소된 게 맞다.

update reservations
   set status = 'cancelled',
       cancelled_at = now()
 where id = 'e1d80338-a0f7-44e3-aff7-f922f2e0ba16'
   and status = 'confirmed';

-- 백필 때 자동 생성된 "막기" 할 일 2건(네이버·아임웹) — 이미 취소된 예약이니 막을 필요 없음.
update block_tasks
   set status = 'skipped'
 where reservation_id = 'e1d80338-a0f7-44e3-aff7-f922f2e0ba16'
   and status = 'pending';

-- 신선한 비운영 DB(verify-0023.sql·배포 체크리스트가 요구하는 환경)엔 이 UUID 예약이 없어
-- FK 위반으로 마이그레이션 체인이 중단되고 0023 이 영영 안 붙는다. 예약이 있을 때만 삽입.
insert into reservation_events (reservation_id, actor, type, detail)
select
  'e1d80338-a0f7-44e3-aff7-f922f2e0ba16'::uuid,
  null,
  'note',
  jsonb_build_object(
    'note', '7월 백필 때 합성키(진짜 예약번호 없음)로 들어와 자동 취소 감지 대상에서 빠졌던 건 — 운영자 확인 후 취소로 수동 정정함'
  )
where exists (
  select 1 from reservations where id = 'e1d80338-a0f7-44e3-aff7-f922f2e0ba16'::uuid
);
